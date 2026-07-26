import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  canonicalAgentApiCredentialBytes,
  generateAgentApiCredential,
} from "../api/credential.js";
import { initializeAuthorityRuntime, authorityRuntimePaths } from "../authority/runtime.js";
import { generateOwnerKey } from "../vault.js";
import { generateWalletKey } from "../wallet.js";
import { installRecoveryApiCredential } from "./api-credential.js";
import { canonicalOperatorManifestBytes } from "./manifest.js";
import {
  HOST_BOOTSTRAP_GROUPS,
  HOST_BOOTSTRAP_PATHS,
  HOST_BOOTSTRAP_PRINCIPALS,
  HostBootstrapError,
  hostBootstrapTopology,
  hostBootstrapRequestDigest,
  operatorSpecForHostBootstrap,
  parseHostBootstrapRequest,
  type HostBootstrapRequest,
  type HostBootstrapTopology,
} from "./host-bootstrap.js";
import {
  installOperatorCandidate,
  operatorProvisioningStatus,
  provisionOperatorCandidate,
} from "./provisioning.js";

const PACKAGE_NAME = "@elldeeone/sompi";
const INSTALL_ROOT = HOST_BOOTSTRAP_PATHS.releaseRoot;
const API_USER = HOST_BOOTSTRAP_PRINCIPALS.api;
const AUTHORITY_USER = HOST_BOOTSTRAP_PRINCIPALS.authority;
const AUTHORITY_IPC_GROUP = HOST_BOOTSTRAP_GROUPS.authorityIpc;
const RECOVERY_GROUP = HOST_BOOTSTRAP_GROUPS.recovery;
const API_MANIFEST = HOST_BOOTSTRAP_PATHS.apiManifest;
const AUTHORITY_MANIFEST = HOST_BOOTSTRAP_PATHS.authorityManifest;
const API_CREDENTIAL = HOST_BOOTSTRAP_PATHS.apiCredential;
const RECOVERY_CREDENTIAL = HOST_BOOTSTRAP_PATHS.recoveryCredential;
const API_SOCKET = HOST_BOOTSTRAP_PATHS.agentApiSocket;
const RECOVERY_SOCKET = HOST_BOOTSTRAP_PATHS.recoverySocket;
const AUTHORITY_SOCKET = HOST_BOOTSTRAP_PATHS.authoritySocket;
const CALLBACK_SOCKET = HOST_BOOTSTRAP_PATHS.callbackSocket;
const PRINCIPAL_NAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const HERMES_AGENT_FILE_SCRIPT = `
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [operation, ...args] = process.argv.slice(1);
const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;

function entryExists(filename) {
  try { fs.lstatSync(filename); return true; }
  catch (cause) {
    if (cause?.code === "ENOENT") return false;
    throw cause;
  }
}

function regular(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("unsafe Hermes file");
  }
  return stat;
}

function digest(filename) {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function assertBoundFile(filename, devText, inoText, digestText) {
  const stat = regular(filename);
  if (
    BigInt(stat.dev) !== BigInt(devText) ||
    BigInt(stat.ino) !== BigInt(inoText) ||
    digest(filename) !== digestText
  ) {
    throw new Error("Hermes configuration changed after installation");
  }
}

function normalize(root, executableFiles) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) throw new Error("unsafe Hermes link");
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(root)) normalize(path.join(root, entry), executableFiles);
    fs.chmodSync(root, 0o700);
    return;
  }
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("unsafe Hermes entry");
  fs.chmodSync(root, executableFiles && (stat.mode & 0o111) !== 0 ? 0o700 : 0o600);
}

function copyTreeContents(source, target) {
  for (const name of fs.readdirSync(source).sort()) {
    const sourceEntry = path.join(source, name);
    const targetEntry = path.join(target, name);
    const stat = fs.lstatSync(sourceEntry);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      fs.mkdirSync(targetEntry, { mode: 0o700 });
      copyTreeContents(sourceEntry, targetEntry);
    } else if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
      fs.copyFileSync(sourceEntry, targetEntry, fs.constants.COPYFILE_EXCL);
    } else {
      throw new Error("unsafe Hermes integration source");
    }
  }
}

function reportIdentity(filename) {
  const stat = fs.lstatSync(filename, { bigint: true });
  process.stdout.write(JSON.stringify({
    filename,
    dev: String(stat.dev),
    ino: String(stat.ino),
  }) + "\\n");
}

function publishBytes(target, bytes, mode) {
  const temporary = target + ".sompi-install-" + process.pid;
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      mode,
    );
    fs.fchmodSync(descriptor, mode);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, target);
    fs.unlinkSync(temporary);
    reportIdentity(target);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function entryKind(stat) {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  if (stat.isSymbolicLink()) return "symlink";
  throw new Error("unsafe Hermes inventory entry");
}

function inventory(root, current = root, relative = "") {
  const stat = fs.lstatSync(current, { bigint: true });
  const entries = [{
    relative,
    kind: entryKind(stat),
    dev: String(stat.dev),
    ino: String(stat.ino),
  }];
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(current).sort()) {
      const childRelative = relative ? path.join(relative, name) : name;
      entries.push(...inventory(root, path.join(current, name), childRelative));
    }
  }
  return entries;
}

if (operation === "mkdir") {
  const [target] = args;
  fs.mkdirSync(target, { mode: 0o700 });
  fs.chmodSync(target, 0o700);
  reportIdentity(target);
} else if (operation === "copy") {
  const [source, target] = args;
  if (entryExists(target)) throw new Error("Hermes target exists");
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("unsafe Hermes integration source");
  }
  const temporary = fs.mkdtempSync(target + ".sompi-install-");
  try {
    fs.chmodSync(temporary, 0o700);
    copyTreeContents(source, temporary);
    normalize(temporary, false);
    if (entryExists(target)) throw new Error("Hermes target appeared during installation");
    fs.renameSync(temporary, target);
    reportIdentity(target);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
} else if (operation === "normalize-executable-tree") {
  normalize(args[0], true);
} else if (operation === "write") {
  const [target, encoded] = args;
  const bytes = Buffer.from(encoded, "base64");
  try {
    publishBytes(target, bytes, 0o600);
  } finally {
    bytes.fill(0);
  }
} else if (operation === "copy-secret") {
  const [source, target] = args;
  const sourceDescriptor = fs.openSync(source, fs.constants.O_RDONLY | noFollow);
  let bytes;
  try {
    const sourceStat = fs.fstatSync(sourceDescriptor);
    if (
      !sourceStat.isFile() ||
      sourceStat.nlink !== 1 ||
      sourceStat.uid !== process.getuid() ||
      sourceStat.gid !== process.getgid() ||
      (sourceStat.mode & 0o777) !== 0o400 ||
      sourceStat.size < 2 ||
      sourceStat.size > 16 * 1024
    ) {
      throw new Error("unsafe agent credential source");
    }
    bytes = fs.readFileSync(sourceDescriptor);
    publishBytes(target, bytes, 0o600);
  } finally {
    bytes?.fill(0);
    fs.closeSync(sourceDescriptor);
  }
} else if (operation === "restore") {
  const [source, target, modeText, devText, inoText, digestText] = args;
  regular(source);
  assertBoundFile(target, devText, inoText, digestText);
  const bytes = fs.readFileSync(source);
  const descriptor = fs.openSync(target, fs.constants.O_WRONLY | noFollow);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (opened.dev !== BigInt(devText) || opened.ino !== BigInt(inoText)) {
      throw new Error("Hermes configuration changed after installation");
    }
    fs.ftruncateSync(descriptor, 0);
    fs.writeFileSync(descriptor, bytes);
    fs.fchmodSync(descriptor, Number(modeText));
    fs.fsyncSync(descriptor);
  } finally {
    bytes.fill(0);
    fs.closeSync(descriptor);
  }
} else if (operation === "remove-bound-file") {
  const [target, devText, inoText, digestText] = args;
  if (entryExists(target)) {
    assertBoundFile(target, devText, inoText, digestText);
    fs.unlinkSync(target);
  }
} else if (operation === "inventory") {
  const [target] = args;
  process.stdout.write(JSON.stringify(inventory(target)) + "\\n");
} else if (operation === "remove-inventory") {
  const [root, manifestFilename] = args;
  const entries = JSON.parse(fs.readFileSync(manifestFilename, "utf8"));
  const byRelative = new Map(entries.map((entry) => [entry.relative, entry]));
  const matches = (filename, entry) => {
    if (!entryExists(filename)) return false;
    const stat = fs.lstatSync(filename, { bigint: true });
    return entryKind(stat) === entry.kind &&
      stat.dev === BigInt(entry.dev) &&
      stat.ino === BigInt(entry.ino);
  };
  const ancestorsMatch = (relative) => {
    const components = relative ? relative.split(path.sep) : [];
    let ancestorRelative = "";
    let ancestor = root;
    const rootEntry = byRelative.get("");
    if (!rootEntry || !matches(root, rootEntry)) {
      return false;
    }
    if (components.length === 0) return true;
    if (rootEntry.kind !== "directory") return false;
    for (const component of components.slice(0, -1)) {
      ancestorRelative = ancestorRelative
        ? path.join(ancestorRelative, component)
        : component;
      ancestor = path.join(ancestor, component);
      const entry = byRelative.get(ancestorRelative);
      if (!entry || entry.kind !== "directory" || !matches(ancestor, entry)) {
        return false;
      }
    }
    return true;
  };
  for (const entry of [...entries].sort((left, right) => {
    const depth = (value) => value.relative ? value.relative.split(path.sep).length : 0;
    return depth(right) - depth(left);
  })) {
    if (
      typeof entry.relative !== "string" ||
      path.isAbsolute(entry.relative) ||
      entry.relative.split(path.sep).includes("..")
    ) {
      throw new Error("unsafe Hermes rollback inventory");
    }
    const target = entry.relative ? path.join(root, entry.relative) : root;
    if (!ancestorsMatch(entry.relative) || !matches(target, entry)) continue;
    if (entry.kind === "directory") {
      try {
        fs.rmdirSync(target);
      } catch (cause) {
        if (cause?.code !== "ENOTEMPTY" && cause?.code !== "EEXIST") throw cause;
      }
    } else {
      fs.unlinkSync(target);
    }
  }
  if (entryExists(root)) {
    throw new Error("Hermes rollback path contains untracked or replaced data");
  }
} else if (operation === "link") {
  const [source, target, exclude] = args;
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink() || entryExists(target)) {
    throw new Error("unsafe Hermes runtime link");
  }
  fs.symlinkSync(source, target, "dir");
  fs.appendFileSync(exclude, "\\n/venv\\n", { encoding: "utf8" });
} else {
  throw new Error("invalid Hermes file operation");
}
`;

interface PrincipalIds {
  readonly apiUid: number;
  readonly apiGid: number;
  readonly authorityUid: number;
  readonly authorityGid: number;
  readonly authorityIpcGid: number;
  /** Selected agent primary group, used only by the two agent-facing sockets. */
  readonly agentSocketGid: number;
  readonly recoveryGid: number;
  readonly callbackGid: number;
  readonly agentUid: number;
  readonly agentGid: number;
  readonly agentGroupName: string;
  readonly agentHome: string;
}

interface PasswdEntry {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
  readonly home: string;
  readonly shell: string;
}

interface HermesConfigSnapshot {
  filename: string;
  bytes?: Buffer;
  uid?: number;
  gid?: number;
  mode?: number;
  configuredIdentity?: Readonly<{ dev: bigint; ino: bigint }>;
  configuredDigest?: string;
  configuredAbsent?: boolean;
  configurationAttempted?: boolean;
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

interface RollbackEntry {
  readonly label: string;
  readonly undo: () => void;
}

type HostRollbackReversal =
  HostBootstrapTopology["rollback"]["reverses"][number];

interface RollbackPathClaim {
  readonly emptyOnly: boolean;
  readonly requiresReportedIdentity: boolean;
  readonly allowSymlink: boolean;
  readonly remove?: (filename: string, claim: RollbackPathClaim) => void;
  identity?: Readonly<{ dev: bigint; ino: bigint }>;
  inventory?: readonly AgentPathIdentity[];
}

interface CreatedPathIdentity {
  readonly filename: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface AgentPathIdentity {
  readonly relative: string;
  readonly kind: "directory" | "file" | "symlink";
  readonly dev: bigint;
  readonly ino: bigint;
}

class HostRollbackLedger {
  private entries: RollbackEntry[] = [];
  private readonly trackedAbsentPaths = new Map<string, RollbackPathClaim>();
  private readonly trackedMutableDirectories = new Set<string>();
  private readonly coveredReversals = new Set<HostRollbackReversal>();

  trackAbsentPath(target: string): void {
    this.trackAbsentEntry(target, false, false, false);
  }

  trackAbsentSymlink(target: string): void {
    this.trackAbsentEntry(target, false, false, true);
  }

  trackAbsentAgentPath(
    target: string,
    agentUser: string,
    runner: HostCommandRunner,
  ): void {
    this.trackAbsentEntry(target, false, true, false, (filename, claim) => {
      removeHermesAgentInventory(
        agentUser,
        runner,
        filename,
        claim,
      );
    });
  }

  private trackAbsentDirectory(target: string): void {
    this.trackAbsentEntry(target, true, false, false);
  }

  private trackAbsentEntry(
    target: string,
    removeOnlyWhenEmpty: boolean,
    requiresReportedIdentity: boolean,
    allowTargetSymlink: boolean,
    remove?: (filename: string, claim: RollbackPathClaim) => void,
  ): void {
    this.cover("files and directories");
    const resolved = path.resolve(target);
    if (pathEntryExists(resolved)) return;
    const absent: string[] = [];
    for (let current = resolved; !pathEntryExists(current); current = path.dirname(current)) {
      if (this.trackedAbsentPaths.has(current)) break;
      absent.push(current);
      const parent = path.dirname(current);
      if (parent === current) {
        throw new HostBootstrapError("Host Bootstrap rollback path has no existing parent");
      }
    }
    for (const current of absent.reverse()) {
      const emptyOnly = current !== resolved || removeOnlyWhenEmpty;
      const claim: RollbackPathClaim = {
        emptyOnly,
        requiresReportedIdentity,
        allowSymlink: current === resolved && allowTargetSymlink,
        remove,
      };
      this.trackedAbsentPaths.set(current, claim);
      this.add(`remove ${current}`, () => {
        removeRollbackPath(current, claim);
        this.trackedAbsentPaths.delete(current);
      });
    }
  }

  bindCreatedPaths(): void {
    for (const [target, claim] of this.trackedAbsentPaths) {
      if (claim.identity || !pathEntryExists(target)) continue;
      if (claim.requiresReportedIdentity) {
        throw new HostBootstrapError("Hermes created path identity was not reported");
      }
      const stat = fs.lstatSync(target, { bigint: true });
      if (stat.isSymbolicLink() !== claim.allowSymlink) {
        throw new HostBootstrapError("Host Bootstrap created path was replaced");
      }
      claim.identity = Object.freeze({ dev: stat.dev, ino: stat.ino });
    }
    for (const [target, claim] of this.trackedAbsentPaths) {
      if (
        claim.identity &&
        !claim.requiresReportedIdentity &&
        !claim.emptyOnly
      ) {
        claim.inventory = captureLocalRollbackInventory(target);
      }
    }
  }

  bindCreatedAgentPath(identity: CreatedPathIdentity): void {
    const target = path.resolve(identity.filename);
    const claim = this.trackedAbsentPaths.get(target);
    if (!claim) {
      throw new HostBootstrapError("Hermes created an untracked path");
    }
    const stat = fs.lstatSync(target, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      stat.dev !== identity.dev ||
      stat.ino !== identity.ino
    ) {
      throw new HostBootstrapError("Hermes created path was replaced");
    }
    if (
      claim.identity &&
      (claim.identity.dev !== identity.dev || claim.identity.ino !== identity.ino)
    ) {
      throw new HostBootstrapError("Hermes created path identity changed");
    }
    claim.identity = Object.freeze({ dev: identity.dev, ino: identity.ino });
  }

  bindAgentInventory(
    target: string,
    inventory: readonly AgentPathIdentity[],
  ): void {
    const resolved = path.resolve(target);
    const claim = this.trackedAbsentPaths.get(resolved);
    const root = inventory.find((entry) => entry.relative === "");
    if (
      !claim ||
      !claim.identity ||
      claim.emptyOnly ||
      !root ||
      root.dev !== claim.identity.dev ||
      root.ino !== claim.identity.ino
    ) {
      throw new HostBootstrapError("Hermes rollback inventory does not match its created path");
    }
    claim.inventory = Object.freeze([...inventory]);
  }

  refreshLocalInventories(targets: readonly string[]): void {
    for (const target of targets) {
      const resolved = path.resolve(target);
      const claim = this.trackedAbsentPaths.get(resolved);
      if (
        !claim ||
        !claim.identity ||
        claim.requiresReportedIdentity ||
        claim.emptyOnly ||
        !pathEntryExists(resolved)
      ) {
        throw new HostBootstrapError(
          "Host Bootstrap service-state rollback path is unavailable",
        );
      }
      const inventory = captureLocalRollbackInventory(resolved);
      const root = inventory.find((entry) => entry.relative === "");
      if (
        !root ||
        root.dev !== claim.identity.dev ||
        root.ino !== claim.identity.ino
      ) {
        throw new HostBootstrapError(
          "Host Bootstrap service-state rollback path was replaced",
        );
      }
      claim.inventory = inventory;
    }
  }

  trackDirectoryMutation(target: string): void {
    this.cover("files and directories");
    const resolved = path.resolve(target);
    if (this.trackedMutableDirectories.has(resolved)) return;
    this.trackedMutableDirectories.add(resolved);
    if (!pathEntryExists(resolved)) {
      this.trackAbsentDirectory(resolved);
      return;
    }
    const descriptor = fs.openSync(
      resolved,
      fs.constants.O_RDONLY |
        (fs.constants.O_DIRECTORY ?? 0) |
        noFollowFlag(),
    );
    let uid: number;
    let gid: number;
    let mode: number;
    let dev: bigint;
    let ino: bigint;
    try {
      const stat = fs.fstatSync(descriptor, { bigint: true });
      if (!stat.isDirectory()) {
        throw new HostBootstrapError("Host Bootstrap mutable parent is unsafe");
      }
      uid = Number(stat.uid);
      gid = Number(stat.gid);
      mode = Number(stat.mode & 0o7777n);
      dev = stat.dev;
      ino = stat.ino;
    } finally {
      fs.closeSync(descriptor);
    }
    this.add(`restore ${resolved} ownership and mode`, () => {
      const restoreDescriptor = fs.openSync(
        resolved,
        fs.constants.O_RDONLY |
          (fs.constants.O_DIRECTORY ?? 0) |
          noFollowFlag(),
      );
      try {
        const current = fs.fstatSync(restoreDescriptor, { bigint: true });
        if (
          !current.isDirectory() ||
          current.dev !== dev ||
          current.ino !== ino
        ) {
          throw new HostBootstrapError("Host Bootstrap mutable parent was replaced");
        }
        fs.fchownSync(restoreDescriptor, uid, gid);
        fs.fchmodSync(restoreDescriptor, mode);
      } finally {
        fs.closeSync(restoreDescriptor);
      }
    });
  }

  trackFileModeMutation(target: string): void {
    this.cover("files and directories");
    const descriptor = fs.openSync(
      target,
      fs.constants.O_RDONLY | noFollowFlag(),
    );
    let mode: number;
    let dev: bigint;
    let ino: bigint;
    try {
      const stat = fs.fstatSync(descriptor, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n) {
        throw new HostBootstrapError("Host Bootstrap executable source is unsafe");
      }
      mode = Number(stat.mode & 0o7777n);
      dev = stat.dev;
      ino = stat.ino;
    } finally {
      fs.closeSync(descriptor);
    }
    this.add(`restore ${target} mode`, () => {
      const restoreDescriptor = fs.openSync(
        target,
        fs.constants.O_RDONLY | noFollowFlag(),
      );
      try {
        const current = fs.fstatSync(restoreDescriptor, { bigint: true });
        if (
          !current.isFile() ||
          current.nlink !== 1n ||
          current.dev !== dev ||
          current.ino !== ino
        ) {
          throw new HostBootstrapError("Host Bootstrap executable source was replaced");
        }
        fs.fchmodSync(restoreDescriptor, mode);
      } finally {
        fs.closeSync(restoreDescriptor);
      }
    });
  }

  add(label: string, undo: () => void): void {
    this.entries.push({ label, undo });
  }

  cover(reversal: HostRollbackReversal): void {
    this.coveredReversals.add(reversal);
  }

  assertCoverage(expected: readonly HostRollbackReversal[]): void {
    if (
      this.coveredReversals.size !== new Set(expected).size ||
      expected.some((reversal) => !this.coveredReversals.has(reversal))
    ) {
      throw new HostBootstrapError(
        "Host Bootstrap rollback implementation does not cover its topology",
      );
    }
  }

  rollback(): readonly string[] {
    const failures: string[] = [];
    for (const entry of this.entries.reverse()) {
      try {
        entry.undo();
      } catch {
        failures.push(entry.label);
      }
    }
    this.entries = [];
    this.trackedAbsentPaths.clear();
    this.trackedMutableDirectories.clear();
    this.coveredReversals.clear();
    return Object.freeze(failures);
  }

  commit(): void {
    this.entries = [];
    this.trackedAbsentPaths.clear();
    this.trackedMutableDirectories.clear();
    this.coveredReversals.clear();
  }
}

class HostBootstrapSignalGuard {
  private interruptedBy: NodeJS.Signals | undefined;
  private rollingBack = false;
  private readonly handlers = new Map<NodeJS.Signals, () => void>();

  constructor() {
    for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
      const handler = (): void => {
        this.interruptedBy ??= signal;
      };
      this.handlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  wrap(runner: HostCommandRunner): HostCommandRunner {
    return Object.freeze({
      run: (
        command: string,
        args: readonly string[],
        options: Readonly<{ cwd?: string }> = {},
      ): string => {
        this.throwIfInterrupted();
        const output = runner.run(command, args, options);
        this.throwIfInterrupted();
        return output;
      },
    });
  }

  async checkpoint(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.throwIfInterrupted();
  }

  beginRollback(): void {
    this.rollingBack = true;
  }

  close(): void {
    for (const [signal, handler] of this.handlers) {
      process.off(signal, handler);
    }
    this.handlers.clear();
  }

  private throwIfInterrupted(): void {
    if (this.interruptedBy && !this.rollingBack) {
      throw new HostBootstrapError(
        `host bootstrap was interrupted by ${this.interruptedBy}`,
      );
    }
  }
}

export async function installHostBootstrap(
  requestInput: HostBootstrapRequest,
  expectedDigest: string,
  options: HostInstallOptions,
): Promise<HostBootstrapReceipt> {
  const request = parseHostBootstrapRequest(requestInput);
  const topology = hostBootstrapTopology(request);
  const digest = hostBootstrapRequestDigest(request);
  if (digest !== expectedDigest) throw new HostBootstrapError("host bootstrap digest does not match the reviewed request");
  if (request.packageVersion !== options.runningPackageVersion) {
    throw new HostBootstrapError("host bootstrap request does not match the running package version");
  }
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new HostBootstrapError("host bootstrap must run as root outside the agent session");
  }
  const signalGuard = new HostBootstrapSignalGuard();
  const runner = signalGuard.wrap(
    options.commandRunner ?? new SystemHostCommandRunner(),
  );
  const rollback = new HostRollbackLedger();
  let token: Buffer | undefined;
  let hermesConfig: HermesConfigSnapshot | undefined;
  let hermesWasActive: boolean | undefined;
  let stage = "validating the reviewed request";
  try {
    preflightCleanHost(request, options.packageRoot, runner);
    const releasePrefix = path.join(INSTALL_ROOT, request.packageVersion);
    rollback.trackAbsentPath(releasePrefix);
    const releasePackageRoot = ensureReleasePackage(
      request.packageVersion,
      options.packageRoot,
    );
    rollback.bindCreatedPaths();
    const ids = ensurePrincipals(request.agent.user, runner, rollback);
    assertMemberships(topology, ids, request.agent.user, runner);
    hermesWasActive = hermesServiceWasActive(ids, runner);
    rollback.trackAbsentPath(request.telegramBotTokenFile);
    try {
      token = readOrPromptTelegramToken(request.telegramBotTokenFile);
    } finally {
      rollback.bindCreatedPaths();
    }
    hermesConfig = snapshotHermesConfig(ids);
    await signalGuard.checkpoint();
    const owner = generateOwnerKey();
    const telegram = request.operator.authority.telegram;
    if (!telegram || !token.toString("utf8").trim().startsWith(`${telegram.botId}:`)) {
      throw new HostBootstrapError("Telegram bot token does not match the reviewed bot ID");
    }

    const candidate = path.join("/var/lib", `.sompi-bootstrap-${process.pid}-${Date.now()}`);
    rollback.trackAbsentPath(candidate);
    stage = "provisioning the operator manifest";
    const spec = operatorSpecForHostBootstrap(request, owner.publicKey);
    let provisioned: ReturnType<typeof provisionOperatorCandidate>;
    try {
      provisioned = provisionOperatorCandidate(spec, candidate);
    } finally {
      rollback.bindCreatedPaths();
    }
    await signalGuard.checkpoint();

    const apiStateParent = path.dirname(spec.dataDirectory);
    rollback.trackDirectoryMutation(apiStateParent);
    rollback.trackAbsentPath(spec.dataDirectory);
    rollback.trackDirectoryMutation(path.dirname(API_MANIFEST));
    rollback.trackAbsentPath(API_MANIFEST);
    try {
      installOperatorCandidate(candidate, API_MANIFEST, provisioned.digest, {
        operatorUserId: 0,
        runtimeUserId: ids.apiUid,
        runtimeGroupId: ids.apiGid,
      });
    } finally {
      rollback.bindCreatedPaths();
    }
    prepareStateDirectory(apiStateParent, ids.apiUid, ids.apiGid);
    let fundingAddress: string;
    try {
      fundingAddress = installFundingWallet(spec.dataDirectory, ids);
    } finally {
      rollback.bindCreatedPaths();
    }
    rollback.trackDirectoryMutation(path.dirname(AUTHORITY_MANIFEST));
    rollback.trackAbsentPath(AUTHORITY_MANIFEST);
    try {
      installAuthorityManifest(provisioned.manifest, ids.authorityIpcGid);
    } finally {
      rollback.bindCreatedPaths();
    }
    rollback.trackAbsentPath(API_CREDENTIAL);
    const clientCredential = agentCredentialPath(ids);
    rollback.trackAbsentAgentPath(clientCredential, request.agent.user, runner);
    installAgentApiCredentialPair(
      API_CREDENTIAL,
      clientCredential,
      request.agent.user,
      ids,
      runner,
      rollback,
    );
    rollback.bindCreatedPaths();
    rollback.trackDirectoryMutation(path.dirname(RECOVERY_CREDENTIAL));
    rollback.trackAbsentPath(RECOVERY_CREDENTIAL);
    try {
      prepareCredentialDirectory(path.dirname(RECOVERY_CREDENTIAL), ids.recoveryGid);
      installRecoveryApiCredential(RECOVERY_CREDENTIAL, { operatorUserId: 0, runtimeGroupId: ids.recoveryGid });
    } finally {
      rollback.bindCreatedPaths();
    }

    stage = "initializing the trusted Authority";
    const authorityPaths = authorityRuntimePaths({
      privateDirectory: "/var/lib/sompi-authority/private",
      clientDirectory: "/var/lib/sompi-authority-client",
      runtimeDirectory: "/run/sompi-authority",
      callbackRuntimeDirectory: "/run/sompi-telegram-callback",
      socketPath: AUTHORITY_SOCKET,
    });
    rollback.trackDirectoryMutation(path.dirname(authorityPaths.privateDirectory));
    rollback.trackAbsentPath(authorityPaths.privateDirectory);
    rollback.trackAbsentPath(authorityPaths.clientDirectory);
    rollback.trackDirectoryMutation(authorityPaths.runtimeDirectory);
    rollback.trackDirectoryMutation(authorityPaths.callbackRuntimeDirectory);
    rollback.trackDirectoryMutation("/run/sompi-api");
    rollback.trackDirectoryMutation("/run/sompi-recovery");
    try {
      await initializeAuthorityRuntime(authorityPaths, {
        issuer: authorityIssuer(request.agent.user),
        kid: "authority-signing-key-1",
      });
    } finally {
      rollback.bindCreatedPaths();
    }
    prepareStateDirectory(path.dirname(authorityPaths.privateDirectory), ids.authorityUid, ids.authorityGid);
    try {
      writeSecret(
        authorityPaths.telegramBotToken,
        token,
        ids.authorityUid,
        ids.authorityGid,
      );
    } finally {
      rollback.bindCreatedPaths();
    }
    chownTree(authorityPaths.privateDirectory, ids.authorityUid, ids.authorityGid, 0o700, 0o600);
    chownTree(authorityPaths.clientDirectory, ids.apiUid, ids.apiGid, 0o700, 0o600);
    for (const prepare of [
      () => prepareRuntimeDirectory("/run/sompi-authority", ids.authorityUid, ids.authorityIpcGid),
      () => prepareRuntimeDirectory("/run/sompi-telegram-callback", ids.authorityUid, ids.callbackGid, 0o2710),
      () => prepareRuntimeDirectory("/run/sompi-api", ids.apiUid, ids.agentSocketGid, 0o2710),
      () => prepareRuntimeDirectory("/run/sompi-recovery", ids.apiUid, ids.recoveryGid),
    ]) {
      try {
        prepare();
      } finally {
        rollback.bindCreatedPaths();
      }
    }
    const serviceStateRoots = Object.freeze([
      spec.dataDirectory,
      authorityPaths.privateDirectory,
    ]);
    await signalGuard.checkpoint();

    stage = "installing recovery and service assets";
    rollback.trackAbsentPath(request.ownerRecoveryFile);
    try {
      installRecoveryRecord(request.ownerRecoveryFile, {
        requestDigest: digest,
        ownerPrivate: owner.privateKey,
        ownerPublic: owner.publicKey,
        vaultAddress: provisioned.vaultAddress,
        manifestDigest: provisioned.digest,
      });
    } finally {
      rollback.bindCreatedPaths();
    }
    for (const executable of executableLinks()) {
      rollback.trackAbsentSymlink(executable);
    }
    for (const source of executableSources(releasePackageRoot)) {
      rollback.trackFileModeMutation(source);
    }
    installExecutables(releasePackageRoot, rollback);
    rollback.add("reload systemd after service asset removal", () => {
      runner.run("systemctl", ["daemon-reload"]);
    });
    for (const target of [
      HOST_BOOTSTRAP_PATHS.apiUnit,
      HOST_BOOTSTRAP_PATHS.authorityUnit,
      HOST_BOOTSTRAP_PATHS.activationUnit,
      HOST_BOOTSTRAP_PATHS.tmpfiles,
    ]) rollback.trackAbsentPath(target);
    installSystemd(releasePackageRoot, request, ids, rollback);
    await signalGuard.checkpoint();

    stage = "installing the Hermes integration";
    const hermesTargets = [
      path.join(ids.agentHome, ".hermes", "skills", "sompi"),
      path.join(ids.agentHome, ".hermes", "plugins", "sompi-approval"),
      path.join(ids.agentHome, ".sompi", "hermes-compat", request.packageVersion),
      path.join(ids.agentHome, ".config", "systemd", "user", "hermes-gateway.service.d", "sompi.conf"),
    ];
    rollback.add("restore the Hermes configuration", () => {
      restoreHermesConfigStrict(hermesConfig!, hermesWasActive!, ids, runner);
    });
    rollback.cover("Hermes configuration");
    for (const target of hermesTargets) {
      rollback.trackAbsentAgentPath(target, request.agent.user, runner);
    }
    rollback.add("stop Hermes before integration removal", () => {
      stopHermes(ids, runner);
    });
    const hermesPythonPath = installHermesIntegration(
      releasePackageRoot,
      request,
      ids,
      runner,
      rollback,
    );
    installHermesServiceDropIn(
      request,
      ids,
      hermesPythonPath,
      runner,
      rollback,
    );
    hermesConfig.configurationAttempted = true;
    try {
      configureHermes(topology, request, ids, hermesPythonPath, runner);
    } finally {
      bindConfiguredHermesState(hermesConfig, ids);
    }
    rollback.bindCreatedPaths();
    await signalGuard.checkpoint();

    stage = "starting and verifying services";
    rollback.add("disable started Sompi services", () => {
      const failures: string[] = [];
      try {
        for (const service of [...topology.startupOrder].reverse()) {
          if (service === "hermes-gateway") continue;
          try { runner.run("systemctl", ["disable", "--now", `${service}.service`]); }
          catch { failures.push(`stop ${service}`); }
        }
        try { runner.run("systemctl", ["daemon-reload"]); }
        catch { failures.push("reload systemd"); }
      } finally {
        try { rollback.refreshLocalInventories(serviceStateRoots); }
        catch (cause) {
          failures.push(
            cause instanceof Error
              ? `bind service state: ${cause.message}`
              : "bind service state",
          );
        }
      }
      if (failures.length > 0) {
        throw new HostBootstrapError(
          `Sompi service rollback did not complete: ${failures.join(", ")}`,
        );
      }
    });
    rollback.cover("service activation");
    runner.run("systemctl", ["daemon-reload"]);
    assertEffectiveSompiSystemdUnits(runner);
    runner.run("systemd-tmpfiles", ["--create", "/etc/tmpfiles.d/sompi.conf"]);
    for (const service of topology.startupOrder) {
      try {
        if (service === "hermes-gateway") {
          restartHermes(ids, runner);
        } else {
          runner.run("systemctl", ["enable", "--now", `${service}.service`]);
        }
      } finally {
        rollback.refreshLocalInventories(serviceStateRoots);
      }
      await signalGuard.checkpoint();
    }
    verifyHostBootstrapTopology(topology, request, ids, hermesPythonPath, runner);
    operatorProvisioningStatus(API_MANIFEST, {
      operatorUserId: 0,
      runtimeUserId: ids.apiUid,
      runtimeGroupId: ids.apiGid,
    });
    await signalGuard.checkpoint();
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
      services: topology.startupOrder,
      activateCommand: `sudo sompi-operator bootstrap-activate ${shellQuote(path.resolve(options.requestFilename))} ${shellQuote(digest)}`,
      next: "fund the displayed Testnet-10 funding address, then run activateCommand",
    });
    rollback.trackDirectoryMutation(path.dirname(HOST_BOOTSTRAP_PATHS.bootstrapReceipt));
    rollback.trackAbsentPath(HOST_BOOTSTRAP_PATHS.bootstrapReceipt);
    try {
      writeBootstrapReceipt(receipt);
    } finally {
      rollback.bindCreatedPaths();
    }
    await signalGuard.checkpoint();
    fs.rmSync(candidate, { recursive: true, force: true });
    rollback.assertCoverage(topology.rollback.reverses);
    await signalGuard.checkpoint();
    rollback.commit();
    return receipt;
  } catch (cause) {
    signalGuard.beginRollback();
    const rollbackFailures = rollback.rollback();
    if (rollbackFailures.length > 0) {
      throw new HostBootstrapError(
        `host bootstrap failed during ${stage}; rollback needs operator inspection: ${rollbackFailures.join(", ")}`,
        { cause },
      );
    }
    if (cause instanceof HostBootstrapError) throw cause;
    throw new HostBootstrapError(`host bootstrap failed safely during ${stage} and removed incomplete unfunded state`, { cause });
  } finally {
    token?.fill(0);
    hermesConfig?.bytes?.fill(0);
    signalGuard.close();
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
  const topology = hostBootstrapTopology(request);
  const ids = installedPrincipalIds(request.agent.user, runner);
  assertMemberships(topology, ids, request.agent.user, runner);
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
  runner.run("systemctl", ["daemon-reload"]);
  assertEffectiveSompiSystemdUnits(runner);
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
  for (const command of [
    "getent", "id", "groupadd", "groupdel", "gpasswd", "useradd", "userdel",
    "usermod", "runuser", "test", "git", "systemctl", "systemd-tmpfiles",
  ]) {
    runner.run("sh", ["-c", `command -v ${command} >/dev/null`]);
  }
  if (!fs.existsSync("/run/systemd/system")) throw new HostBootstrapError("host bootstrap requires systemd");
  assertRootOwnedAncestors(request.ownerRecoveryFile);
  assertRootOwnedAncestors(request.telegramBotTokenFile);
  assertRootOwnedAncestors(path.join(INSTALL_ROOT, request.packageVersion));
  assertInstalledReleasePackageRoot(request.packageVersion, packageRoot);
  assertSompiServiceNamesAvailable(runner);
  assertSompiPrincipalNamesAvailable(runner);
  const systemdUnitPaths = systemdManagerUnitPaths(runner);
  for (const target of [
    "/etc/sompi",
    "/etc/sompi-authority",
    API_MANIFEST,
    AUTHORITY_MANIFEST,
    API_CREDENTIAL,
    path.dirname(RECOVERY_CREDENTIAL),
    "/var/lib/sompi-api",
    "/var/lib/sompi-api/runtime",
    "/var/lib/sompi-authority",
    "/var/lib/sompi-authority/private",
    HOST_BOOTSTRAP_PATHS.authorityClient,
    "/var/lib/sompi-bootstrap",
    "/run/sompi-authority",
    "/run/sompi-telegram-callback",
    "/run/sompi-api",
    "/run/sompi-recovery",
    AUTHORITY_SOCKET,
    CALLBACK_SOCKET,
    API_SOCKET,
    RECOVERY_SOCKET,
    HOST_BOOTSTRAP_PATHS.apiUnit,
    HOST_BOOTSTRAP_PATHS.authorityUnit,
    HOST_BOOTSTRAP_PATHS.activationUnit,
    HOST_BOOTSTRAP_PATHS.tmpfiles,
    ...sompiSystemdConflictPaths(systemdUnitPaths),
    request.ownerRecoveryFile,
    ...executableLinks(),
  ]) {
    if (pathEntryExists(target)) throw new HostBootstrapError("host bootstrap requires a clean host without active Sompi state");
  }
  const passwd = getPasswd(request.agent.user, runner);
  assertSafeAgentDirectory(passwd.home, passwd.uid);
  const checkout = path.join(passwd.home, ".hermes", "hermes-agent");
  assertSafeAgentDirectory(checkout, passwd.uid);
  const hermesDropInDirectory = path.join(
    passwd.home,
    ".config",
    "systemd",
    "user",
    "hermes-gateway.service.d",
  );
  if (pathEntryExists(hermesDropInDirectory)) {
    assertSafeAgentDirectory(hermesDropInDirectory, passwd.uid);
    if (
      fs.readdirSync(hermesDropInDirectory).some((entry) =>
        entry.endsWith(".conf")
      )
    ) {
      throw new HostBootstrapError("Hermes gateway already has a service override");
    }
  }
  const python = path.join(checkout, "venv", "bin", "python");
  if (!fs.existsSync(python) || !fs.existsSync(path.join(checkout, "plugins", "platforms", "telegram", "adapter.py"))) {
    throw new HostBootstrapError("Hermes checkout or runtime is unavailable for the selected OS user");
  }
  for (const target of [
    path.join(passwd.home, ".hermes", "skills", "sompi"),
    path.join(passwd.home, ".hermes", "plugins", "sompi-approval"),
    path.join(passwd.home, ".sompi", "agent-api.json"),
    path.join(passwd.home, ".sompi", "hermes-compat", request.packageVersion),
    path.join(passwd.home, ".config", "systemd", "user", "hermes-gateway.service.d", "sompi.conf"),
  ]) {
    if (pathEntryExists(target)) throw new HostBootstrapError("host bootstrap requires a clean Hermes integration target");
  }
  if (pathEntryExists(request.telegramBotTokenFile)) {
    readRootSecret(request.telegramBotTokenFile, "Telegram bot token").fill(0);
  } else if (!fs.existsSync("/dev/tty")) {
    throw new HostBootstrapError("Telegram bot token file is absent and no local operator terminal is available");
  }
}

function systemdManagerUnitPaths(runner: HostCommandRunner): readonly string[] {
  const output = runner.run("systemctl", [
    "show",
    "--property=UnitPath",
    "--value",
  ]);
  if (output.length === 0 || output.length > 64 * 1024) {
    throw new HostBootstrapError("systemd unit search path is invalid");
  }
  const entries = output.trim().split(/\s+/);
  const unique = new Set<string>();
  for (const entry of entries) {
    if (
      !path.isAbsolute(entry) ||
      path.normalize(entry) !== entry ||
      entry === "/" ||
      entry.includes("\0")
    ) {
      throw new HostBootstrapError("systemd unit search path is invalid");
    }
    unique.add(entry);
  }
  if (
    !unique.has("/etc/systemd/system") ||
    !unique.has("/run/systemd/system")
  ) {
    throw new HostBootstrapError("systemd unit search path is incomplete");
  }
  return Object.freeze([...unique]);
}

function sompiSystemdConflictPaths(
  unitPaths: readonly string[],
): readonly string[] {
  const conflicts = new Set<string>();
  for (const directory of unitPaths) {
    conflicts.add(path.join(directory, "service.d"));
    for (const unit of [
      "sompi-authority.service",
      "sompi-api.service",
      "sompi-vault-activate.service",
    ]) {
      conflicts.add(path.join(directory, unit));
      conflicts.add(path.join(directory, `${unit}.d`));
      const stem = unit.slice(0, -".service".length);
      const parts = stem.split("-");
      for (let length = parts.length - 1; length > 0; length -= 1) {
        conflicts.add(
          path.join(
            directory,
            `${parts.slice(0, length).join("-")}-.service.d`,
          ),
        );
      }
    }
  }
  return Object.freeze([...conflicts]);
}

function assertRootOwnedAncestors(filename: string): void {
  for (
    let current = path.dirname(path.resolve(filename));
    ;
    current = path.dirname(current)
  ) {
    if (pathEntryExists(current)) {
      const stat = fs.lstatSync(current);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== 0 ||
        (stat.mode & 0o022) !== 0
      ) {
        throw new HostBootstrapError("Host Bootstrap root path ancestor is unsafe");
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
  }
}

function expectedReleasePackageRoot(version: string): string {
  return path.join(
    INSTALL_ROOT,
    version,
    "node_modules",
    "@elldeeone",
    "sompi",
  );
}

function assertInstalledReleasePackageRoot(
  version: string,
  packageRoot: string,
): void {
  const expected = expectedReleasePackageRoot(version);
  if (path.resolve(packageRoot) !== expected) {
    throw new HostBootstrapError("host bootstrap is not running from the reviewed release");
  }
  let real: string;
  try {
    real = fs.realpathSync(expected);
  } catch (cause) {
    throw new HostBootstrapError("reviewed Sompi release is unavailable", { cause });
  }
  if (real !== expected) {
    throw new HostBootstrapError("reviewed Sompi release path is indirect");
  }
  for (
    let current = expected;
    ;
    current = path.dirname(current)
  ) {
    const stat = fs.lstatSync(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0
    ) {
      throw new HostBootstrapError("reviewed Sompi release path is unsafe");
    }
    if (current === "/opt") break;
    const parent = path.dirname(current);
    if (parent === current || !current.startsWith("/opt/")) {
      throw new HostBootstrapError("reviewed Sompi release path is unsafe");
    }
  }
}

function assertSompiServiceNamesAvailable(runner: HostCommandRunner): void {
  for (const service of [
    "sompi-authority.service",
    "sompi-api.service",
    "sompi-vault-activate.service",
  ]) {
    const output = runner.run("systemctl", [
      "show",
      service,
      "--property=LoadState",
      "--property=ActiveState",
      "--property=UnitFileState",
    ]);
    const state = new Map(
      output.trimEnd().split("\n").map((line) => {
        const separator = line.indexOf("=");
        if (separator <= 0) throw new HostBootstrapError("systemd returned invalid service state");
        return [line.slice(0, separator), line.slice(separator + 1)] as const;
      }),
    );
    if (
      state.get("LoadState") !== "not-found" ||
      state.get("ActiveState") !== "inactive" ||
      !["", "not-found"].includes(state.get("UnitFileState") ?? "\0")
    ) {
      throw new HostBootstrapError("host bootstrap requires unused Sompi service names");
    }
  }
}

function assertEffectiveSompiSystemdUnits(
  runner: HostCommandRunner,
): void {
  for (const unit of [
    "sompi-authority.service",
    "sompi-api.service",
    "sompi-vault-activate.service",
  ]) {
    const output = runner.run("systemctl", [
      "show",
      unit,
      "--property=LoadState",
      "--property=FragmentPath",
      "--property=DropInPaths",
      "--property=NeedDaemonReload",
    ]);
    if (output.length === 0 || output.length > 64 * 1024) {
      throw new HostBootstrapError(
        "systemd returned invalid effective Sompi unit state",
      );
    }
    const state = new Map<string, string>();
    for (const line of output.trimEnd().split("\n")) {
      const separator = line.indexOf("=");
      if (
        separator <= 0 ||
        state.has(line.slice(0, separator))
      ) {
        throw new HostBootstrapError(
          "systemd returned invalid effective Sompi unit state",
        );
      }
      state.set(
        line.slice(0, separator),
        line.slice(separator + 1),
      );
    }
    if (
      !sameStringSet(
        new Set(state.keys()),
        ["LoadState", "FragmentPath", "DropInPaths", "NeedDaemonReload"],
      ) ||
      state.get("LoadState") !== "loaded" ||
      state.get("FragmentPath") !== `/etc/systemd/system/${unit}` ||
      state.get("DropInPaths") !== "" ||
      state.get("NeedDaemonReload") !== "no"
    ) {
      throw new HostBootstrapError(
        "effective Sompi systemd unit projection is unsafe",
      );
    }
  }
}

function assertSompiPrincipalNamesAvailable(runner: HostCommandRunner): void {
  for (const user of [API_USER, AUTHORITY_USER]) {
    if (getPasswd(user, runner, true)) {
      throw new HostBootstrapError("host bootstrap requires unused Sompi service users");
    }
  }
  for (const group of Object.values(HOST_BOOTSTRAP_GROUPS)) {
    if (getGroup(group, runner, true)) {
      throw new HostBootstrapError("host bootstrap requires unused Sompi service groups");
    }
  }
}

function ensureReleasePackage(
  version: string,
  currentPackageRoot: string,
): string {
  const installedRoot = expectedReleasePackageRoot(version);
  if (path.resolve(currentPackageRoot) !== installedRoot) {
    throw new HostBootstrapError("host bootstrap is not running from the reviewed release");
  }
  return installedRoot;
}

function ensurePrincipals(
  agentUser: string,
  runner: HostCommandRunner,
  rollback: HostRollbackLedger,
): PrincipalIds {
  for (const group of [
    API_USER,
    AUTHORITY_USER,
    AUTHORITY_IPC_GROUP,
    RECOVERY_GROUP,
  ]) {
    if (!getGroup(group, runner, true)) {
      runner.run("groupadd", ["--system", group]);
      rollback.add(`remove created group ${group}`, () => {
        if (getGroup(group, runner, true)) runner.run("groupdel", [group]);
      });
      rollback.cover("service principals and groups");
    }
  }
  if (!getPasswd(API_USER, runner, true)) {
    runner.run("useradd", ["--system", "--gid", API_USER, "--home-dir", "/var/lib/sompi-api", "--shell", "/usr/sbin/nologin", API_USER]);
    rollback.add(`remove created user ${API_USER}`, () => {
      if (getPasswd(API_USER, runner, true)) runner.run("userdel", [API_USER]);
    });
    rollback.cover("service principals and groups");
  }
  if (!getPasswd(AUTHORITY_USER, runner, true)) {
    runner.run("useradd", ["--system", "--gid", AUTHORITY_USER, "--home-dir", "/var/lib/sompi-authority", "--shell", "/usr/sbin/nologin", AUTHORITY_USER]);
    rollback.add(`remove created user ${AUTHORITY_USER}`, () => {
      if (getPasswd(AUTHORITY_USER, runner, true)) runner.run("userdel", [AUTHORITY_USER]);
    });
    rollback.cover("service principals and groups");
  }
  const agent = getPasswd(agentUser, runner);
  const agentGroup = getGroupById(agent.gid, runner);
  const protectedGroups = [
    0,
    getGroup(API_USER, runner).gid,
    getGroup(AUTHORITY_USER, runner).gid,
    getGroup(AUTHORITY_IPC_GROUP, runner).gid,
    getGroup(RECOVERY_GROUP, runner).gid,
  ];
  if (groupIdsForUser(agentUser, runner).some((gid) => protectedGroups.includes(gid))) {
    throw new HostBootstrapError("selected Hermes user already has protected Sompi group access");
  }
  if (groupIdsForUser(AUTHORITY_USER, runner).includes(agent.gid)) {
    throw new HostBootstrapError("Trusted Authority already has Hermes agent-group access");
  }
  if (groupIdsForUser(API_USER, runner).includes(agent.gid)) {
    throw new HostBootstrapError("Sompi API already has Hermes agent-group access");
  }
  for (const group of [AUTHORITY_IPC_GROUP, RECOVERY_GROUP]) {
    ensureSupplementaryMembership(API_USER, group, runner, rollback);
  }
  ensureSupplementaryMembership(AUTHORITY_USER, AUTHORITY_IPC_GROUP, runner, rollback);
  return installedPrincipalIds(agentUser, runner);
}

function installedPrincipalIds(
  agentUser: string,
  runner: HostCommandRunner,
): PrincipalIds {
  const api = getPasswd(API_USER, runner);
  const authority = getPasswd(AUTHORITY_USER, runner);
  const agent = getPasswd(agentUser, runner);
  const agentGroup = getGroupById(agent.gid, runner);
  const ids: PrincipalIds = {
    apiUid: api.uid,
    apiGid: getGroup(API_USER, runner).gid,
    authorityUid: authority.uid,
    authorityGid: getGroup(AUTHORITY_USER, runner).gid,
    authorityIpcGid: getGroup(AUTHORITY_IPC_GROUP, runner).gid,
    agentSocketGid: agent.gid,
    recoveryGid: getGroup(RECOVERY_GROUP, runner).gid,
    callbackGid: agent.gid,
    agentUid: agent.uid,
    agentGid: getGroupById(agent.gid, runner).gid,
    agentGroupName: agentGroup.name,
    agentHome: agent.home,
  };
  if (
    api.gid !== ids.apiGid ||
    authority.gid !== ids.authorityGid ||
    api.home !== "/var/lib/sompi-api" ||
    authority.home !== "/var/lib/sompi-authority" ||
    api.shell !== "/usr/sbin/nologin" ||
    authority.shell !== "/usr/sbin/nologin" ||
    [ids.apiUid, ids.authorityUid, ids.agentUid].some((id) => id === 0) ||
    new Set([ids.apiUid, ids.authorityUid, ids.agentUid]).size !== 3 ||
    [
      ids.apiGid,
      ids.authorityGid,
      ids.authorityIpcGid,
      ids.recoveryGid,
      ids.agentGid,
    ]
      .some((id) => id === 0) ||
    new Set([
      ids.apiGid,
      ids.authorityGid,
      ids.authorityIpcGid,
      ids.recoveryGid,
      ids.agentGid,
    ]).size !== 5 ||
    !PRINCIPAL_NAME_PATTERN.test(ids.agentGroupName)
  ) {
    throw new HostBootstrapError("Host Bootstrap principal topology is unsafe");
  }
  const uidOwners = new Map<number, string[]>();
  for (const line of runner.run("getent", ["passwd"]).trim().split("\n")) {
    const fields = line.split(":");
    if (fields.length !== 7 || !fields[0]) {
      throw new HostBootstrapError("host user database returned invalid data");
    }
    const uid = numericId(fields[2]);
    const owners = uidOwners.get(uid) ?? [];
    owners.push(fields[0]);
    uidOwners.set(uid, owners);
  }
  for (const principal of [api, authority, agent]) {
    if (
      uidOwners.get(principal.uid)?.length !== 1 ||
      uidOwners.get(principal.uid)?.[0] !== principal.name
    ) {
      throw new HostBootstrapError("Host Bootstrap principal UID is aliased");
    }
  }
  return Object.freeze(ids);
}

function ensureSupplementaryMembership(
  user: string,
  group: string,
  runner: HostCommandRunner,
  rollback: HostRollbackLedger,
): void {
  const gid = getGroup(group, runner).gid;
  if (groupIdsForUser(user, runner).includes(gid)) return;
  runner.run("usermod", ["-a", "-G", group, user]);
  rollback.add(`remove ${user} from ${group}`, () => {
    runner.run("gpasswd", ["-d", user, group]);
  });
  rollback.cover("supplementary memberships");
}

function groupIdsForUser(user: string, runner: HostCommandRunner): readonly number[] {
  const output = runner.run("id", ["-G", user]).trim();
  if (!output) throw new HostBootstrapError("host principal group lookup returned no groups");
  return Object.freeze(output.split(/\s+/).map(numericId));
}

function installAuthorityManifest(manifest: unknown, gid: number): void {
  fs.mkdirSync(path.dirname(AUTHORITY_MANIFEST), { recursive: true, mode: 0o750 });
  fs.chownSync(path.dirname(AUTHORITY_MANIFEST), 0, gid);
  fs.chmodSync(path.dirname(AUTHORITY_MANIFEST), 0o750);
  const bytes = canonicalOperatorManifestBytes(manifest);
  try { writeExclusive(AUTHORITY_MANIFEST, bytes, 0, gid, 0o640); } finally { bytes.fill(0); }
}

function installExecutables(
  packageRoot: string,
  rollback: HostRollbackLedger,
): void {
  const entries = executableEntries();
  for (const [name, relative] of Object.entries(entries)) {
    const source = path.join(packageRoot, relative);
    const target = path.join("/usr/local/bin", name);
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new HostBootstrapError("installed Sompi executable is unsafe");
    fs.chmodSync(source, 0o755);
    fs.symlinkSync(source, target);
    rollback.bindCreatedPaths();
  }
}

function executableEntries(): Readonly<Record<string, string>> {
  return Object.freeze({
    "sompi-agent": "dist/agent-main.js",
    "sompi-api": "dist/api-main.js",
    "sompi-authority": "dist/authority-main.js",
    "sompi-operator": "dist/operator-main.js",
    "sompi-vault-recover": "scripts/vault-recover.js",
  });
}

function executableSources(packageRoot: string): string[] {
  return Object.values(executableEntries()).map((relative) => path.join(packageRoot, relative));
}

function executableLinks(): string[] {
  return ["sompi-agent", "sompi-api", "sompi-authority", "sompi-operator", "sompi-vault-recover"]
    .map((name) => path.join("/usr/local/bin", name));
}

function installSystemd(
  packageRoot: string,
  request: HostBootstrapRequest,
  ids: PrincipalIds,
  rollback: HostRollbackLedger,
): void {
  const authority = renderAuthorityUnit(request, ids);
  const api = renderApiUnit(request, ids);
  const activation = renderVaultActivationUnit(request, ids);
  const tmpfiles = renderTmpfiles(ids.agentGroupName);
  for (const [filename, text] of [
    [HOST_BOOTSTRAP_PATHS.authorityUnit, authority],
    [HOST_BOOTSTRAP_PATHS.apiUnit, api],
    [HOST_BOOTSTRAP_PATHS.activationUnit, activation],
    [HOST_BOOTSTRAP_PATHS.tmpfiles, tmpfiles],
  ] as const) {
    try {
      writeText(filename, text, 0, 0, 0o644);
    } finally {
      rollback.bindCreatedPaths();
    }
  }
  void packageRoot;
}

function renderVaultActivationUnit(request: HostBootstrapRequest, ids: PrincipalIds): string {
  const digest = hostBootstrapRequestDigest(request);
  return `[Unit]\nDescription=Sompi one-time initial vault activation\nAfter=network-online.target sompi-authority.service\nWants=network-online.target\nRequires=sompi-authority.service\nConflicts=sompi-api.service\n\n[Service]\nType=oneshot\nUser=${API_USER}\nGroup=${API_USER}\nSupplementaryGroups=${AUTHORITY_IPC_GROUP} ${RECOVERY_GROUP}\nUMask=0077\nEnvironment=NODE_OPTIONS=--no-network-family-autoselection\nEnvironment=SOMPI_NETWORK=testnet-10\nEnvironment=SOMPI_OPERATOR_MANIFEST=${API_MANIFEST}\nEnvironment=SOMPI_OPERATOR_UID=0\nEnvironment=SOMPI_API_UID=${ids.apiUid}\nEnvironment=SOMPI_RUNTIME_GID=${ids.apiGid}\nEnvironment=SOMPI_API_SOCKET_GID=${ids.agentSocketGid}\nEnvironment=SOMPI_RECOVERY_GID=${ids.recoveryGid}\nEnvironment=SOMPI_API_SOCKET=${API_SOCKET}\nEnvironment=SOMPI_AGENT_API_CREDENTIAL=${API_CREDENTIAL}\nEnvironment=SOMPI_RECOVERY_API_SOCKET=${RECOVERY_SOCKET}\nEnvironment=SOMPI_RECOVERY_API_CREDENTIAL=${RECOVERY_CREDENTIAL}\nEnvironment=SOMPI_AUTHORITY_CLIENT_DIR=/var/lib/sompi-authority-client\nEnvironment=SOMPI_AUTHORITY_RUNTIME_DIR=/run/sompi-authority\nEnvironment=SOMPI_AUTHORITY_SOCKET=${AUTHORITY_SOCKET}\nEnvironment=SOMPI_AUTHORITY_SOCKET_UID=${ids.authorityUid}\nEnvironment=SOMPI_AUTHORITY_SOCKET_GID=${ids.authorityIpcGid}\nEnvironment=SOMPI_AUTHORITY_ISSUER=${authorityIssuer(request.agent.user)}\nEnvironment=SOMPI_AUTHORITY_IPC_KEY_ID=authority-ipc-key-1\nEnvironment=SOMPI_AUTHORITY_INSTRUMENT_ID=kaspa:testnet-10:vault-treasury\nEnvironment=SOMPI_BOOTSTRAP_REQUEST_DIGEST=${digest}\nEnvironment=SOMPI_BOOTSTRAP_MINIMUM_FUNDING_SOMPI=${minimumFundingSompi(request)}\nEnvironment=SOMPI_BOOTSTRAP_MINIMUM_DEPOSIT_SOMPI=${request.initialVault.minimumDepositSompi}\nEnvironment=SOMPI_BOOTSTRAP_KEEP_FLOAT_SOMPI=${request.initialVault.keepFloatSompi}\nExecStart=/usr/local/bin/sompi-operator bootstrap-activate-worker\nNoNewPrivileges=yes\nPrivateTmp=yes\nPrivateDevices=yes\nProtectSystem=strict\nProtectHome=yes\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nLockPersonality=yes\nRestrictSUIDSGID=yes\nCapabilityBoundingSet=\nReadWritePaths=/var/lib/sompi-api/runtime /var/lib/sompi-authority-client\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\n`;
}

function renderAuthorityUnit(request: HostBootstrapRequest, ids: PrincipalIds): string {
  return `[Unit]\nDescription=Sompi Trusted Authority\nAfter=network-online.target systemd-tmpfiles-setup.service\nWants=network-online.target\n\n[Service]\nType=simple\nUser=${AUTHORITY_USER}\nGroup=${AUTHORITY_USER}\nSupplementaryGroups=${AUTHORITY_IPC_GROUP}\nUMask=0077\nEnvironment=NODE_OPTIONS=--no-network-family-autoselection\nEnvironment=SOMPI_AUTHORITY_PRIVATE_DIR=/var/lib/sompi-authority/private\nEnvironment=SOMPI_AUTHORITY_CLIENT_DIR=/var/lib/sompi-authority-client\nEnvironment=SOMPI_AUTHORITY_RUNTIME_DIR=/run/sompi-authority\nEnvironment=SOMPI_AUTHORITY_CALLBACK_RUNTIME_DIR=/run/sompi-telegram-callback\nEnvironment=SOMPI_AUTHORITY_SOCKET=${AUTHORITY_SOCKET}\nEnvironment=SOMPI_AUTHORITY_SOCKET_GID=${ids.authorityIpcGid}\nEnvironment=SOMPI_AUTHORITY_CALLBACK_SOCKET_GID=${ids.callbackGid}\nEnvironment=SOMPI_AUTHORITY_ISSUER=${authorityIssuer(request.agent.user)}\nEnvironment=SOMPI_AUTHORITY_SIGNING_KID=authority-signing-key-1\nEnvironment=SOMPI_AUTHORITY_IPC_KEY_ID=authority-ipc-key-1\nEnvironment=SOMPI_AUTHORITY_INSTRUMENT_ID=kaspa:testnet-10:vault-treasury\nEnvironment=SOMPI_OPERATOR_MANIFEST=${AUTHORITY_MANIFEST}\nEnvironment=SOMPI_OPERATOR_UID=0\nEnvironment=SOMPI_RUNTIME_GID=${ids.authorityIpcGid}\nExecStart=/usr/local/bin/sompi-authority\nRestart=on-failure\nRestartSec=3s\nNoNewPrivileges=yes\nPrivateTmp=yes\nPrivateDevices=yes\nProtectSystem=strict\nProtectHome=yes\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nLockPersonality=yes\nRestrictSUIDSGID=yes\nCapabilityBoundingSet=\nReadWritePaths=/var/lib/sompi-authority/private /run/sompi-authority /run/sompi-telegram-callback\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\n\n[Install]\nWantedBy=multi-user.target\n`;
}

function renderApiUnit(request: HostBootstrapRequest, ids: PrincipalIds): string {
  return `[Unit]\nDescription=Sompi API\nAfter=network-online.target sompi-authority.service systemd-tmpfiles-setup.service\nWants=network-online.target\nRequires=sompi-authority.service\n\n[Service]\nType=simple\nUser=${API_USER}\nGroup=${API_USER}\nSupplementaryGroups=${AUTHORITY_IPC_GROUP} ${RECOVERY_GROUP}\nUMask=0077\nEnvironment=NODE_OPTIONS=--no-network-family-autoselection\nEnvironment=SOMPI_NETWORK=testnet-10\nEnvironment=SOMPI_OPERATOR_MANIFEST=${API_MANIFEST}\nEnvironment=SOMPI_OPERATOR_UID=0\nEnvironment=SOMPI_API_UID=${ids.apiUid}\nEnvironment=SOMPI_RUNTIME_GID=${ids.apiGid}\nEnvironment=SOMPI_API_SOCKET_GID=${ids.agentSocketGid}\nEnvironment=SOMPI_RECOVERY_GID=${ids.recoveryGid}\nEnvironment=SOMPI_API_SOCKET=${API_SOCKET}\nEnvironment=SOMPI_AGENT_API_CREDENTIAL=${API_CREDENTIAL}\nEnvironment=SOMPI_RECOVERY_API_SOCKET=${RECOVERY_SOCKET}\nEnvironment=SOMPI_RECOVERY_API_CREDENTIAL=${RECOVERY_CREDENTIAL}\nEnvironment=SOMPI_AUTHORITY_CLIENT_DIR=/var/lib/sompi-authority-client\nEnvironment=SOMPI_AUTHORITY_RUNTIME_DIR=/run/sompi-authority\nEnvironment=SOMPI_AUTHORITY_SOCKET=${AUTHORITY_SOCKET}\nEnvironment=SOMPI_AUTHORITY_SOCKET_UID=${ids.authorityUid}\nEnvironment=SOMPI_AUTHORITY_SOCKET_GID=${ids.authorityIpcGid}\nEnvironment=SOMPI_AUTHORITY_ISSUER=${authorityIssuer(request.agent.user)}\nEnvironment=SOMPI_AUTHORITY_IPC_KEY_ID=authority-ipc-key-1\nEnvironment=SOMPI_AUTHORITY_INSTRUMENT_ID=kaspa:testnet-10:vault-treasury\nExecStart=/usr/local/bin/sompi-api\nRestart=on-failure\nRestartSec=3s\nNoNewPrivileges=yes\nPrivateTmp=yes\nPrivateDevices=yes\nProtectSystem=strict\nProtectHome=yes\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nLockPersonality=yes\nRestrictSUIDSGID=yes\nCapabilityBoundingSet=\nReadWritePaths=/var/lib/sompi-api/runtime /run/sompi-api /run/sompi-recovery\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\n\n[Install]\nWantedBy=multi-user.target\n`;
}

function renderTmpfiles(agentGroupName = "sompi-agent"): string {
  return `d /run/sompi-authority 0710 ${AUTHORITY_USER} ${AUTHORITY_IPC_GROUP} -\nd /run/sompi-telegram-callback 2710 ${AUTHORITY_USER} ${agentGroupName} -\nd /run/sompi-api 2710 ${API_USER} ${agentGroupName} -\nd /run/sompi-recovery 0710 ${API_USER} ${RECOVERY_GROUP} -\n`;
}

function installHermesIntegration(
  packageRoot: string,
  request: HostBootstrapRequest,
  ids: PrincipalIds,
  runner: HostCommandRunner,
  rollback: HostRollbackLedger,
): string {
  const hermesRoot = path.join(ids.agentHome, ".hermes");
  const checkout = path.join(hermesRoot, "hermes-agent");
  const skillTarget = path.join(hermesRoot, "skills", "sompi");
  const pluginTarget = path.join(hermesRoot, "plugins", "sompi-approval");
  prepareAgentOwnedDirectoryTree(path.dirname(skillTarget), ids, runner, rollback);
  prepareAgentOwnedDirectoryTree(path.dirname(pluginTarget), ids, runner, rollback);
  bindReportedAgentPath(rollback, runHermesAgentFileOperation(
    request.agent.user,
    runner,
    "copy",
    path.join(packageRoot, "integrations", "hermes", "sompi"),
    skillTarget,
  ));
  rollback.bindAgentInventory(
    skillTarget,
    captureHermesAgentInventory(request.agent.user, runner, skillTarget),
  );
  bindReportedAgentPath(rollback, runHermesAgentFileOperation(
    request.agent.user,
    runner,
    "copy",
    path.join(packageRoot, "integrations", "hermes", "plugin"),
    pluginTarget,
  ));
  rollback.bindAgentInventory(
    pluginTarget,
    captureHermesAgentInventory(request.agent.user, runner, pluginTarget),
  );
  let pythonPath = checkout;
  const adapter = path.join(checkout, "plugins", "platforms", "telegram", "adapter.py");
  const pluginManager = path.join(checkout, "hermes_cli", "plugins.py");
  if (!fileContains(adapter, "gateway_callback_query") || !fileContains(pluginManager, '"gateway_callback_query"')) {
    const compatRoot = path.join(ids.agentHome, ".sompi", "hermes-compat", request.packageVersion);
    const patch = path.join(packageRoot, "integrations", "hermes", "compat", "callback-hook.patch");
    prepareAgentOwnedDirectoryTree(compatRoot, ids, runner, rollback);
    rollback.bindAgentInventory(
      compatRoot,
      captureHermesAgentInventory(request.agent.user, runner, compatRoot),
    );
    installHermesCompatibilityCheckout(
      request.agent.user,
      checkout,
      compatRoot,
      patch,
      runner,
      rollback,
    );
    if (!fileContains(path.join(compatRoot, "plugins", "platforms", "telegram", "adapter.py"), "dispatch_plugin_callback_query")) {
      throw new HostBootstrapError("Hermes callback compatibility profile did not install");
    }
    pythonPath = compatRoot;
  }
  if (pythonPath !== checkout) {
    try {
      runHermesAgentFileOperation(
        request.agent.user,
        runner,
        "normalize-executable-tree",
        pythonPath,
      );
      installHermesCompatibilityVenvLink(
        request.agent.user,
        checkout,
        pythonPath,
        runner,
      );
    } finally {
      rollback.bindAgentInventory(
        pythonPath,
        captureHermesAgentInventory(request.agent.user, runner, pythonPath),
      );
    }
  }
  return pythonPath;
}

function installHermesCompatibilityCheckout(
  agentUser: string,
  checkout: string,
  compatRoot: string,
  patch: string,
  runner: HostCommandRunner,
  rollback: HostRollbackLedger,
): void {
  const compatStat = fs.lstatSync(compatRoot);
  if (
    !compatStat.isDirectory() ||
    compatStat.isSymbolicLink() ||
    fs.readdirSync(compatRoot).length !== 0
  ) {
    throw new HostBootstrapError("Hermes compatibility target is unsafe");
  }
  const branch = runAsUserWithOutput(
    agentUser,
    "git",
    ["-C", checkout, "branch", "--show-current"],
    runner,
  ).trim();
  const origin = runAsUserWithOutput(
    agentUser,
    "git",
    ["-C", checkout, "remote", "get-url", "origin"],
    runner,
  ).trim();
  if (!branch || !origin) throw new HostBootstrapError("Hermes compatibility source is not an updateable checkout");
  const mutate = (operation: () => void): void => {
    try {
      operation();
    } finally {
      rollback.bindAgentInventory(
        compatRoot,
        captureHermesAgentInventory(agentUser, runner, compatRoot),
      );
    }
  };
  mutate(() => runAsUser(agentUser, "git", [
    "clone",
    "--no-hardlinks",
    "--dissociate",
    "--single-branch",
    "--branch",
    branch,
    checkout,
    compatRoot,
  ], runner));
  mutate(() => runAsUser(agentUser, "git", ["-C", compatRoot, "remote", "set-url", "origin", origin], runner));
  runAsUser(agentUser, "git", ["-C", compatRoot, "apply", "--check", patch], runner);
  mutate(() => runAsUser(agentUser, "git", ["-C", compatRoot, "apply", patch], runner));
  if (!fs.existsSync(path.join(compatRoot, ".git"))) {
    throw new HostBootstrapError("Hermes compatibility checkout lost its update metadata");
  }
}

function installHermesCompatibilityVenvLink(
  agentUser: string,
  checkout: string,
  compatRoot: string,
  runner: HostCommandRunner,
): void {
  const source = path.join(checkout, "venv");
  const target = path.join(compatRoot, "venv");
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink() || fs.existsSync(target)) {
    throw new HostBootstrapError("Hermes compatibility runtime link is unsafe");
  }
  const exclude = path.join(compatRoot, ".git", "info", "exclude");
  runHermesAgentFileOperation(agentUser, runner, "link", source, target, exclude);
}

function installHermesServiceDropIn(
  request: HostBootstrapRequest,
  ids: PrincipalIds,
  pythonPath: string,
  runner: HostCommandRunner,
  rollback: HostRollbackLedger,
): void {
  const directory = path.join(ids.agentHome, ".config", "systemd", "user", "hermes-gateway.service.d");
  prepareAgentOwnedDirectoryTree(directory, ids, runner, rollback);
  const text = renderHermesServiceDropIn(ids, pythonPath);
  bindReportedAgentPath(rollback, runHermesAgentFileOperation(
    request.agent.user,
    runner,
    "write",
    path.join(directory, "sompi.conf"),
    Buffer.from(text, "utf8").toString("base64"),
  ));
  const dropIn = path.join(directory, "sompi.conf");
  rollback.bindAgentInventory(
    dropIn,
    captureHermesAgentInventory(request.agent.user, runner, dropIn),
  );
}

function renderHermesServiceDropIn(ids: PrincipalIds, pythonPath: string): string {
  return `[Service]\nEnvironment="PYTHONDONTWRITEBYTECODE=1"\nEnvironment="PYTHONPATH=${pythonPath}"\nEnvironment="SOMPI_API_SOCKET=${API_SOCKET}"\nEnvironment="SOMPI_AGENT_API_CREDENTIAL=${agentCredentialPath(ids)}"\nEnvironment="SOMPI_OPERATOR_UID=0"\nEnvironment="SOMPI_API_UID=${ids.apiUid}"\nEnvironment="SOMPI_RUNTIME_GID=${ids.agentGid}"\nEnvironment="SOMPI_API_SOCKET_GID=${ids.agentSocketGid}"\n`;
}

function configureHermes(
  topology: HostBootstrapTopology,
  request: HostBootstrapRequest,
  ids: PrincipalIds,
  pythonPath: string,
  runner: HostCommandRunner,
): void {
  const python = path.join(ids.agentHome, ".hermes", "hermes-agent", "venv", "bin", "python");
  const base = [python, "-m", "hermes_cli.main"];
  const env = [
    "env",
    "PYTHONDONTWRITEBYTECODE=1",
    `PYTHONPATH=${pythonPath}`,
  ];
  runAsUser(request.agent.user, env[0], [...env.slice(1), base[0], ...base.slice(1), "config", "set", "plugins.entries.sompi-approval.callback_socket", topology.hermes.callback], runner);
  runAsUser(request.agent.user, env[0], [...env.slice(1), base[0], ...base.slice(1), "config", "set", "plugins.entries.sompi-approval.timeout_ms", "2000"], runner);
  runAsUser(request.agent.user, env[0], [...env.slice(1), base[0], ...base.slice(1), "plugins", "enable", "sompi-approval", "--no-allow-tool-override"], runner);
}

function restartHermes(ids: PrincipalIds, runner: HostCommandRunner): void {
  const environment = [`XDG_RUNTIME_DIR=/run/user/${ids.agentUid}`];
  runner.run("runuser", ["-u", getPasswdById(ids.agentUid, runner).name, "--", "env", ...environment, "systemctl", "--user", "daemon-reload"]);
  runner.run("runuser", ["-u", getPasswdById(ids.agentUid, runner).name, "--", "env", ...environment, "systemctl", "--user", "restart", "hermes-gateway.service"]);
}

function stopHermes(ids: PrincipalIds, runner: HostCommandRunner): void {
  const environment = [`XDG_RUNTIME_DIR=/run/user/${ids.agentUid}`];
  runner.run("runuser", [
    "-u",
    getPasswdById(ids.agentUid, runner).name,
    "--",
    "env",
    ...environment,
    "systemctl",
    "--user",
    "stop",
    "hermes-gateway.service",
  ]);
}

function assertServiceActive(service: string, runner: HostCommandRunner): void {
  if (runner.run("systemctl", ["is-active", service]).trim() !== "active") throw new HostBootstrapError("Sompi service did not become active");
}

function assertHermesActive(ids: PrincipalIds, runner: HostCommandRunner): void {
  const user = getPasswdById(ids.agentUid, runner).name;
  const result = runner.run("runuser", ["-u", user, "--", "env", `XDG_RUNTIME_DIR=/run/user/${ids.agentUid}`, "systemctl", "--user", "is-active", "hermes-gateway.service"]);
  if (result.trim() !== "active") throw new HostBootstrapError("Hermes gateway did not become active");
}

function hermesServiceWasActive(
  ids: PrincipalIds,
  runner: HostCommandRunner,
): boolean {
  const user = getPasswdById(ids.agentUid, runner).name;
  const result = runner.run("runuser", [
    "-u",
    user,
    "--",
    "env",
    `XDG_RUNTIME_DIR=/run/user/${ids.agentUid}`,
    "systemctl",
    "--user",
    "show",
    "--property=ActiveState",
    "--value",
    "hermes-gateway.service",
  ]).trim();
  if (result === "active") return true;
  if (result === "inactive") return false;
  throw new HostBootstrapError("Hermes gateway initial state is unavailable");
}

function verifyHostBootstrapTopology(
  topology: ReturnType<typeof hostBootstrapTopology>,
  request: HostBootstrapRequest,
  ids: PrincipalIds,
  hermesPythonPath: string,
  runner: HostCommandRunner,
): void {
  assertMemberships(topology, ids, request.agent.user, runner);
  assertEffectiveSompiSystemdUnits(runner);
  assertInstalledFileTopology(topology, request, ids);
  assertInstalledHermesTopology(topology, request, ids, hermesPythonPath, runner);
  for (const service of topology.startupOrder) {
    if (service === "hermes-gateway") {
      assertHermesActive(ids, runner);
    } else {
      assertServiceActive(`${service}.service`, runner);
    }
  }
  waitForSocketTopology(topology, ids);
  assertAccessTopology(topology, request, ids, runner);
}

function assertMemberships(
  topology: HostBootstrapTopology,
  ids: PrincipalIds,
  agentUser: string,
  runner: HostCommandRunner,
): void {
  const apiGroups = groupIdsForUser(API_USER, runner);
  if (
    !sameNumericSet(
      apiGroups,
      [
        topologyNamedGroupGid(topology.memberships.api.primary, ids),
        ...topology.memberships.api.supplementary.map((group) =>
          topologyNamedGroupGid(group, ids)
        ),
      ],
    )
  ) {
    throw new HostBootstrapError("Sompi API group topology is unsafe");
  }
  const authorityGroups = groupIdsForUser(AUTHORITY_USER, runner);
  if (
    !sameNumericSet(
      authorityGroups,
      [
        topologyNamedGroupGid(topology.memberships.authority.primary, ids),
        ...topology.memberships.authority.supplementary.map((group) =>
          topologyNamedGroupGid(group, ids)
        ),
      ],
    )
  ) {
    throw new HostBootstrapError("Trusted Authority group topology is unsafe");
  }
  const agentGroups = groupIdsForUser(agentUser, runner);
  if (
    !topology.memberships.agent.supplementary.every((group) =>
      agentGroups.includes(topologyNamedGroupGid(group, ids))
    ) ||
    topology.memberships.agent.forbidden.some((group) =>
      agentGroups.includes(topologyNamedGroupGid(group, ids))
    )
  ) {
    throw new HostBootstrapError("Hermes agent group topology is unsafe");
  }
  assertCapabilityGroupClosure(ids, agentUser, runner);
}

function topologyNamedGroupGid(
  group: string,
  ids: PrincipalIds,
): number {
  if (group === "root") return 0;
  if (group === HOST_BOOTSTRAP_GROUPS.api) return ids.apiGid;
  if (group === HOST_BOOTSTRAP_GROUPS.authority) return ids.authorityGid;
  if (group === HOST_BOOTSTRAP_GROUPS.authorityIpc) return ids.authorityIpcGid;
  if (group === HOST_BOOTSTRAP_GROUPS.recovery) return ids.recoveryGid;
  if (group === "selected-agent-primary-group") return ids.agentSocketGid;
  throw new HostBootstrapError("Host Bootstrap topology names an unknown group");
}

function assertCapabilityGroupClosure(
  ids: PrincipalIds,
  agentUser: string,
  runner: HostCommandRunner,
): void {
  const primaryMembers = new Map<number, Set<string>>();
  for (const line of runner.run("getent", ["passwd"]).trim().split("\n")) {
    const fields = line.split(":");
    if (fields.length !== 7 || !fields[0]) {
      throw new HostBootstrapError("host user database returned invalid data");
    }
    const gid = numericId(fields[3]);
    const members = primaryMembers.get(gid) ?? new Set<string>();
    members.add(fields[0]);
    primaryMembers.set(gid, members);
  }
  const explicitMembers = new Map<number, Set<string>>();
  for (const line of runner.run("getent", ["group"]).trim().split("\n")) {
    const fields = line.split(":");
    if (fields.length !== 4 || !fields[0]) {
      throw new HostBootstrapError("host group database returned invalid data");
    }
    const gid = numericId(fields[2]);
    const members = explicitMembers.get(gid) ?? new Set<string>();
    for (const member of fields[3] ? fields[3].split(",") : []) {
      if (!member) throw new HostBootstrapError("host group database returned invalid data");
      members.add(member);
    }
    explicitMembers.set(gid, members);
  }
  const closures = [
    [ids.apiGid, [API_USER]],
    [ids.authorityGid, [AUTHORITY_USER]],
    [ids.agentSocketGid, [agentUser]],
    [ids.authorityIpcGid, [API_USER, AUTHORITY_USER]],
    [ids.recoveryGid, [API_USER]],
  ] as const;
  for (const [gid, expected] of closures) {
    const actual = new Set([
      ...(primaryMembers.get(gid) ?? []),
      ...(explicitMembers.get(gid) ?? []),
    ]);
    if (!sameStringSet(actual, expected)) {
      throw new HostBootstrapError("Host Bootstrap capability group is not closed");
    }
  }
}

function sameNumericSet(
  actual: readonly number[],
  expected: readonly number[],
): boolean {
  return (
    new Set(actual).size === new Set(expected).size &&
    expected.every((value) => actual.includes(value))
  );
}

function sameStringSet(
  actual: ReadonlySet<string>,
  expected: readonly string[],
): boolean {
  return actual.size === new Set(expected).size &&
    expected.every((value) => actual.has(value));
}

function topologyPrincipalUid(
  principal: HostBootstrapTopology["sockets"][number]["owner"],
  ids: PrincipalIds,
): number {
  return principal === API_USER ? ids.apiUid : ids.authorityUid;
}

function topologyGroupGid(
  group: HostBootstrapTopology["sockets"][number]["group"],
  ids: PrincipalIds,
): number {
  if (group === AUTHORITY_IPC_GROUP) return ids.authorityIpcGid;
  if (group === RECOVERY_GROUP) return ids.recoveryGid;
  return ids.agentSocketGid;
}

function assertInstalledFileTopology(
  topology: HostBootstrapTopology,
  request: HostBootstrapRequest,
  ids: PrincipalIds,
): void {
  assertHostEntry(path.dirname(API_MANIFEST), "directory", 0, ids.apiGid, 0o750);
  assertHostEntry(API_MANIFEST, "file", 0, ids.apiGid, 0o640);
  assertHostEntry(path.dirname(AUTHORITY_MANIFEST), "directory", 0, ids.authorityIpcGid, 0o750);
  assertHostEntry(AUTHORITY_MANIFEST, "file", 0, ids.authorityIpcGid, 0o640);
  assertHostEntry(topology.secrets.apiCredential, "file", 0, ids.apiGid, 0o640);
  assertHostEntry(
    resolveAgentTopologyPath(topology.secrets.agentCredential, ids.agentHome),
    "file",
    ids.agentUid,
    ids.agentGid,
    0o600,
  );
  assertHostEntry(path.dirname(topology.secrets.recoveryCredential), "directory", 0, ids.recoveryGid, 0o750);
  assertHostEntry(topology.secrets.recoveryCredential, "file", 0, ids.recoveryGid, 0o640);
  assertHostEntry(topology.secrets.ownerRecovery, "file", 0, 0, 0o600);
  assertHostEntry("/var/lib/sompi-api", "directory", ids.apiUid, ids.apiGid, 0o700);
  assertHostEntry(topology.secrets.authorityPrivate, "directory", ids.authorityUid, ids.authorityGid, 0o700);
  assertHostEntry("/var/lib/sompi-authority", "directory", ids.authorityUid, ids.authorityGid, 0o700);
  assertHostEntry(path.join(topology.secrets.authorityPrivate, "telegram-bot-token"), "file", ids.authorityUid, ids.authorityGid, 0o600);
  assertHostEntry("/var/lib/sompi-authority-client", "directory", ids.apiUid, ids.apiGid, 0o700);
  assertHostEntry(topology.secrets.apiRuntime, "directory", ids.apiUid, ids.apiGid, 0o700);
  for (const socket of topology.sockets) {
    assertHostEntry(
      path.dirname(socket.path),
      "directory",
      topologyPrincipalUid(socket.owner, ids),
      topologyGroupGid(socket.group, ids),
      Number.parseInt(socket.directoryMode, 8),
    );
  }

  const authority = readRegularText(HOST_BOOTSTRAP_PATHS.authorityUnit, 64 * 1024, 0);
  const api = readRegularText(HOST_BOOTSTRAP_PATHS.apiUnit, 64 * 1024, 0);
  const activation = readRegularText(HOST_BOOTSTRAP_PATHS.activationUnit, 64 * 1024, 0);
  const tmpfiles = readRegularText(HOST_BOOTSTRAP_PATHS.tmpfiles, 64 * 1024, 0);
  if (
    authority !== renderAuthorityUnit(request, ids) ||
    api !== renderApiUnit(request, ids) ||
    activation !== renderVaultActivationUnit(request, ids) ||
    tmpfiles !== renderTmpfiles(ids.agentGroupName)
  ) {
    throw new HostBootstrapError("installed Host Bootstrap service topology changed");
  }
  if (
    !authority.includes(`SupplementaryGroups=${AUTHORITY_IPC_GROUP}\n`) ||
    !api.includes("Requires=sompi-authority.service") ||
    !activation.includes("Conflicts=sompi-api.service")
  ) {
    throw new HostBootstrapError("installed Host Bootstrap startup ordering is unsafe");
  }
  const publicAssets = `${authority}\n${api}\n${activation}\n${tmpfiles}`;
  if (
    publicAssets.includes(request.telegramBotTokenFile) ||
    publicAssets.includes(request.ownerRecoveryFile) ||
    /ownerPrivate|telegram-bot-token/.test(publicAssets)
  ) {
    throw new HostBootstrapError("Host Bootstrap service assets contain a secret locator");
  }
}

function assertInstalledHermesTopology(
  topology: HostBootstrapTopology,
  request: HostBootstrapRequest,
  ids: PrincipalIds,
  pythonPath: string,
  runner: HostCommandRunner,
): void {
  const skill = resolveAgentTopologyPath(topology.hermes.skill, ids.agentHome);
  const plugin = resolveAgentTopologyPath(topology.hermes.plugin, ids.agentHome);
  const dropIn = path.join(ids.agentHome, ".config", "systemd", "user", "hermes-gateway.service.d", "sompi.conf");
  assertHostEntry(skill, "directory", ids.agentUid, ids.agentGid, 0o700);
  assertHostEntry(plugin, "directory", ids.agentUid, ids.agentGid, 0o700);
  assertHostEntry(dropIn, "file", ids.agentUid, ids.agentGid, 0o600);
  const expectedDropIn = renderHermesServiceDropIn(ids, pythonPath);
  if (readRegularText(dropIn, 64 * 1024, ids.agentUid) !== expectedDropIn) {
    throw new HostBootstrapError("installed Hermes service projection changed");
  }
  if (
    !fileContains(path.join(pythonPath, "plugins", "platforms", "telegram", "adapter.py"), "gateway_callback_query") ||
    !fileContains(path.join(pythonPath, "hermes_cli", "plugins.py"), '"gateway_callback_query"')
  ) {
    throw new HostBootstrapError("installed Hermes callback hook is unavailable");
  }
  const sourceCheckout = path.join(ids.agentHome, ".hermes", "hermes-agent");
  if (pythonPath !== sourceCheckout) {
    if (fs.existsSync(path.join(pythonPath, ".git", "objects", "info", "alternates"))) {
      throw new HostBootstrapError("Hermes compatibility checkout still borrows Git objects");
    }
    runAsUser(request.agent.user, "git", ["-C", pythonPath, "cat-file", "-e", "HEAD^{tree}"], runner);
    runAsUser(request.agent.user, "git", ["-C", pythonPath, "fsck", "--full"], runner);
    if (
      !runAsUserWithOutput(request.agent.user, "git", ["-C", pythonPath, "branch", "--show-current"], runner).trim() ||
      !runAsUserWithOutput(request.agent.user, "git", ["-C", pythonPath, "remote", "get-url", "origin"], runner).trim()
    ) {
      throw new HostBootstrapError("Hermes compatibility checkout is not updateable");
    }
  }
  const settings = new Map([
    ["plugins.entries.sompi-approval.callback_socket", topology.hermes.callback],
    ["plugins.entries.sompi-approval.timeout_ms", "2000"],
    ["plugins.entries.sompi-approval.enabled", "true"],
    ["plugins.entries.sompi-approval.allow_tool_override", "false"],
  ]);
  for (const [key, expected] of settings) {
    if (
      readHermesConfigSetting(
        request.agent.user,
        ids,
        pythonPath,
        key,
        runner,
      ) !== expected
    ) {
      throw new HostBootstrapError("installed Hermes configuration changed");
    }
  }
  assertHermesEffectiveEnvironment(request.agent.user, ids, pythonPath, runner);
}

function assertHermesEffectiveEnvironment(
  agentUser: string,
  ids: PrincipalIds,
  pythonPath: string,
  runner: HostCommandRunner,
): void {
  const output = runner.run("runuser", [
    "-u",
    agentUser,
    "--",
    "env",
    `XDG_RUNTIME_DIR=/run/user/${ids.agentUid}`,
    "systemctl",
    "--user",
    "show",
    "--property=Environment",
    "--value",
    "hermes-gateway.service",
  ]).trim();
  const expected = new Map([
    ["PYTHONDONTWRITEBYTECODE", "1"],
    ["PYTHONPATH", pythonPath],
    ["SOMPI_API_SOCKET", API_SOCKET],
    ["SOMPI_AGENT_API_CREDENTIAL", agentCredentialPath(ids)],
    ["SOMPI_OPERATOR_UID", "0"],
    ["SOMPI_API_UID", String(ids.apiUid)],
    ["SOMPI_RUNTIME_GID", String(ids.agentGid)],
    ["SOMPI_API_SOCKET_GID", String(ids.agentSocketGid)],
  ]);
  for (const [key, value] of expected) {
    const assignment = `${key}=${value}`;
    const matches = output
      .split(/\s+/)
      .map((entry) => entry.replace(/^"|"$/g, ""))
      .filter((entry) => entry === assignment);
    if (matches.length !== 1) {
      throw new HostBootstrapError(
        "effective Hermes service environment changed",
      );
    }
  }
}

function readHermesConfigSetting(
  agentUser: string,
  ids: PrincipalIds,
  pythonPath: string,
  key: string,
  runner: HostCommandRunner,
): string {
  const python = path.join(
    ids.agentHome,
    ".hermes",
    "hermes-agent",
    "venv",
    "bin",
    "python",
  );
  return runAsUserWithOutput(
    agentUser,
    "env",
    [
      "PYTHONDONTWRITEBYTECODE=1",
      `PYTHONPATH=${pythonPath}`,
      python,
      "-m",
      "hermes_cli.main",
      "config",
      "get",
      key,
    ],
    runner,
  ).trim();
}

function resolveAgentTopologyPath(
  projectedPath: string,
  agentHome: string,
): string {
  if (!projectedPath.startsWith("~/")) {
    throw new HostBootstrapError("Host Bootstrap Hermes topology path is invalid");
  }
  const resolved = path.resolve(agentHome, projectedPath.slice(2));
  const relative = path.relative(agentHome, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HostBootstrapError("Host Bootstrap Hermes topology path is unsafe");
  }
  return resolved;
}

function waitForSocketTopology(
  topology: HostBootstrapTopology,
  ids: PrincipalIds,
): void {
  const expected = topology.sockets.map((socket) => [
    socket.path,
    topologyPrincipalUid(socket.owner, ids),
    topologyGroupGid(socket.group, ids),
    Number.parseInt(socket.mode, 8),
  ] as const);
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (expected.every(([filename]) => {
      try { return fs.lstatSync(filename).isSocket(); } catch { return false; }
    })) break;
    Atomics.wait(waiter, 0, 0, 50);
  }
  for (const [filename, uid, gid, mode] of expected) {
    assertHostEntry(filename, "socket", uid, gid, mode);
  }
}

function assertAccessTopology(
  topology: HostBootstrapTopology,
  request: HostBootstrapRequest,
  ids: PrincipalIds,
  runner: HostCommandRunner,
): void {
  for (const access of topology.access) {
    const user =
      access.principal === "agent"
        ? request.agent.user
        : access.principal === "operator"
          ? HOST_BOOTSTRAP_PRINCIPALS.operator
          : access.principal;
    for (const check of access.checks) {
      const checkedPath = check.path.startsWith("~/")
        ? resolveAgentTopologyPath(check.path, ids.agentHome)
        : check.path;
      if (check.kind === "read") {
        assertReadAccess(user, checkedPath, check.allowed, runner);
      } else {
        assertSocketAccess(user, checkedPath, check.allowed, runner);
      }
    }
  }
}

function assertReadAccess(
  user: string,
  filename: string,
  expected: boolean,
  runner: HostCommandRunner,
): void {
  const actual = hostCommandSucceeds(runner, "runuser", ["-u", user, "--", "test", "-r", filename]);
  if (actual !== expected) throw new HostBootstrapError("Host Bootstrap secret-isolation check failed");
}

function assertSocketAccess(
  user: string,
  socketPath: string,
  expected: boolean,
  runner: HostCommandRunner,
): void {
  const script = [
    "const net=require('node:net');",
    "const socket=net.createConnection(process.argv[1]);",
    "const timer=setTimeout(()=>{socket.destroy();process.exit(2)},1000);",
    "socket.once('connect',()=>{clearTimeout(timer);socket.destroy();process.exit(0)});",
    "socket.once('error',()=>{clearTimeout(timer);process.exit(1)});",
  ].join("");
  const actual = hostCommandSucceeds(
    runner,
    "runuser",
    ["-u", user, "--", process.execPath, "-e", script, socketPath],
  );
  if (actual !== expected) throw new HostBootstrapError("Host Bootstrap socket access check failed");
}

function hostCommandSucceeds(
  runner: HostCommandRunner,
  command: string,
  args: readonly string[],
): boolean {
  try {
    runner.run(command, args);
    return true;
  } catch {
    return false;
  }
}

function assertHostEntry(
  filename: string,
  type: "directory" | "file" | "socket",
  uid: number,
  gid: number,
  mode: number,
): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(filename); }
  catch (cause) { throw new HostBootstrapError("Host Bootstrap topology entry is unavailable", { cause }); }
  const typeMatches =
    type === "directory" ? stat.isDirectory() :
    type === "file" ? stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 :
    stat.isSocket();
  if (
    !typeMatches ||
    stat.uid !== uid ||
    stat.gid !== gid ||
    (stat.mode & 0o7777) !== mode
  ) {
    throw new HostBootstrapError("Host Bootstrap topology entry is unsafe");
  }
}

function runAsUser(user: string, command: string, args: readonly string[], runner: HostCommandRunner): void {
  runAsUserWithOutput(user, command, args, runner);
}

function runAsUserWithOutput(
  user: string,
  command: string,
  args: readonly string[],
  runner: HostCommandRunner,
): string {
  return runner.run("runuser", ["-u", user, "--", command, ...args]);
}

function runHermesAgentFileOperation(
  user: string,
  runner: HostCommandRunner,
  operation: string,
  ...args: readonly string[]
): CreatedPathIdentity | undefined {
  const output = runAsUserWithOutput(
    user,
    process.execPath,
    ["--input-type=module", "--eval", HERMES_AGENT_FILE_SCRIPT, operation, ...args],
    runner,
  );
  if (!output.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (cause) {
    throw new HostBootstrapError("Hermes created path identity is invalid", { cause });
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).filename !== "string" ||
    typeof (value as Record<string, unknown>).dev !== "string" ||
    typeof (value as Record<string, unknown>).ino !== "string"
  ) {
    throw new HostBootstrapError("Hermes created path identity is invalid");
  }
  const record = value as Record<string, string>;
  if (
    !/^(?:0|[1-9][0-9]*)$/.test(record.dev) ||
    !/^(?:0|[1-9][0-9]*)$/.test(record.ino)
  ) {
    throw new HostBootstrapError("Hermes created path identity is invalid");
  }
  return Object.freeze({
    filename: path.resolve(record.filename),
    dev: BigInt(record.dev),
    ino: BigInt(record.ino),
  });
}

function bindReportedAgentPath(
  rollback: HostRollbackLedger,
  identity: CreatedPathIdentity | undefined,
): void {
  if (!identity) {
    throw new HostBootstrapError("Hermes did not report a created path identity");
  }
  rollback.bindCreatedAgentPath(identity);
}

function installAgentApiCredentialPair(
  apiFilename: string,
  agentFilename: string,
  agentUser: string,
  ids: PrincipalIds,
  runner: HostCommandRunner,
  rollback: HostRollbackLedger,
): void {
  const credential = generateAgentApiCredential();
  const bytes = canonicalAgentApiCredentialBytes(credential);
  try {
    try {
      writeExclusive(apiFilename, bytes, 0, ids.apiGid, 0o640);
    } finally {
      rollback.bindCreatedPaths();
    }
    prepareAgentOwnedDirectoryTree(
      path.dirname(agentFilename),
      ids,
      runner,
      rollback,
    );
    const temporaryDirectory = fs.mkdtempSync("/run/sompi-agent-credential-");
    fs.chownSync(temporaryDirectory, ids.agentUid, ids.agentGid);
    fs.chmodSync(temporaryDirectory, 0o700);
    const source = path.join(temporaryDirectory, "agent-api.json");
    try {
      writeExclusive(source, bytes, ids.agentUid, ids.agentGid, 0o400);
      bindReportedAgentPath(rollback, runHermesAgentFileOperation(
        agentUser,
        runner,
        "copy-secret",
        source,
        agentFilename,
      ));
      rollback.bindAgentInventory(
        agentFilename,
        captureHermesAgentInventory(agentUser, runner, agentFilename),
      );
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  } finally {
    bytes.fill(0);
  }
}

function captureHermesAgentInventory(
  user: string,
  runner: HostCommandRunner,
  target: string,
): readonly AgentPathIdentity[] {
  const output = runAsUserWithOutput(
    user,
    process.execPath,
    ["--input-type=module", "--eval", HERMES_AGENT_FILE_SCRIPT, "inventory", target],
    runner,
  );
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (cause) {
    throw new HostBootstrapError("Hermes rollback inventory is invalid", { cause });
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 100_000) {
    throw new HostBootstrapError("Hermes rollback inventory is invalid");
  }
  const seen = new Set<string>();
  const inventory = value.map((entry): AgentPathIdentity => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new HostBootstrapError("Hermes rollback inventory is invalid");
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.relative !== "string" ||
      typeof record.kind !== "string" ||
      typeof record.dev !== "string" ||
      typeof record.ino !== "string" ||
      !["directory", "file", "symlink"].includes(record.kind) ||
      path.isAbsolute(record.relative) ||
      record.relative.split(path.sep).includes("..") ||
      seen.has(record.relative) ||
      !/^(?:0|[1-9][0-9]*)$/.test(record.dev) ||
      !/^(?:0|[1-9][0-9]*)$/.test(record.ino)
    ) {
      throw new HostBootstrapError("Hermes rollback inventory is invalid");
    }
    seen.add(record.relative);
    return Object.freeze({
      relative: record.relative,
      kind: record.kind as AgentPathIdentity["kind"],
      dev: BigInt(record.dev),
      ino: BigInt(record.ino),
    });
  });
  if (!seen.has("")) {
    throw new HostBootstrapError("Hermes rollback inventory has no root");
  }
  return Object.freeze(inventory);
}

function agentCredentialPath(ids: PrincipalIds): string {
  return resolveAgentTopologyPath(
    HOST_BOOTSTRAP_PATHS.agentCredential,
    ids.agentHome,
  );
}

function removeHermesAgentInventory(
  user: string,
  runner: HostCommandRunner,
  target: string,
  claim: RollbackPathClaim,
): void {
  if (!claim.identity) {
    throw new HostBootstrapError("Hermes rollback path identity is unavailable");
  }
  const inventory = claim.inventory ??
    (claim.emptyOnly
      ? [Object.freeze({
          relative: "",
          kind: "directory" as const,
          dev: claim.identity.dev,
          ino: claim.identity.ino,
        })]
      : undefined);
  if (!inventory) {
    throw new HostBootstrapError("Hermes rollback path inventory is unavailable");
  }
  const agent = getPasswd(user, runner);
  const temporaryDirectory = fs.mkdtempSync("/run/sompi-hermes-rollback-");
  fs.chownSync(temporaryDirectory, 0, agent.gid);
  fs.chmodSync(temporaryDirectory, 0o710);
  const manifest = path.join(temporaryDirectory, "inventory.json");
  const bytes = Buffer.from(`${JSON.stringify(inventory.map((entry) => ({
    relative: entry.relative,
    kind: entry.kind,
    dev: String(entry.dev),
    ino: String(entry.ino),
  })))}\n`, "utf8");
  try {
    writeExclusive(manifest, bytes, 0, agent.gid, 0o440);
    const output = runHermesAgentFileOperation(
      user,
      runner,
      "remove-inventory",
      target,
      manifest,
    );
    if (output) {
      throw new HostBootstrapError("Hermes rollback returned unexpected data");
    }
  } finally {
    bytes.fill(0);
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
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

export function verifyHostBootstrapCommitReceipt(
  filename: string,
  expectedPackage: string,
  expectedDigest: string,
): void {
  if (
    filename !== HOST_BOOTSTRAP_PATHS.bootstrapReceipt ||
    !new RegExp(
      `^${PACKAGE_NAME.replace("/", "\\/")}@(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$`,
    ).test(expectedPackage) ||
    !/^sha256:[A-Za-z0-9_-]{43}$/.test(expectedDigest)
  ) {
    throw new HostBootstrapError(
      "host bootstrap commit expectation is invalid",
    );
  }
  const descriptor = fs.openSync(
    filename,
    fs.constants.O_RDONLY | noFollowFlag(),
  );
  let bytes: Buffer | undefined;
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== 0n ||
      before.gid !== 0n ||
      (before.mode & 0o777n) !== 0o600n ||
      before.size < 2n ||
      before.size > 64n * 1024n
    ) {
      throw new HostBootstrapError(
        "host bootstrap commit receipt is unsafe",
      );
    }
    bytes = fs.readFileSync(descriptor);
    const pathname = fs.lstatSync(filename, { bigint: true });
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      pathname.isSymbolicLink() ||
      !pathname.isFile() ||
      pathname.dev !== before.dev ||
      pathname.ino !== before.ino ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      throw new HostBootstrapError(
        "host bootstrap commit receipt changed during validation",
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (cause) {
      throw new HostBootstrapError(
        "host bootstrap commit receipt is invalid",
        { cause },
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new HostBootstrapError("host bootstrap commit receipt is invalid");
    }
    const receipt = value as Record<string, unknown>;
    const agent = receipt.agent;
    const agentIsValid =
      !!agent &&
      typeof agent === "object" &&
      !Array.isArray(agent) &&
      sameStringSet(
        new Set(Object.keys(agent)),
        ["kind", "user"],
      ) &&
      (agent as Record<string, unknown>).kind === "hermes" &&
      typeof (agent as Record<string, unknown>).user === "string" &&
      PRINCIPAL_NAME_PATTERN.test(
        (agent as Record<string, string>).user,
      );
    const expectedKeys = [
      "status",
      "package",
      "requestDigest",
      "manifestDigest",
      "vaultAddress",
      "fundingAddress",
      "minimumFundingSompi",
      "ownerRecoveryFile",
      "agent",
      "services",
      "activateCommand",
      "next",
    ];
    if (
      !sameStringSet(new Set(Object.keys(receipt)), expectedKeys) ||
      receipt.status !== "ready" ||
      receipt.package !== expectedPackage ||
      receipt.requestDigest !== expectedDigest ||
      typeof receipt.manifestDigest !== "string" ||
      !/^sha256:[A-Za-z0-9_-]{43}$/.test(receipt.manifestDigest) ||
      typeof receipt.vaultAddress !== "string" ||
      !/^kaspatest:[a-z0-9]{11,240}$/.test(receipt.vaultAddress) ||
      typeof receipt.fundingAddress !== "string" ||
      !/^kaspatest:[a-z0-9]{11,240}$/.test(receipt.fundingAddress) ||
      typeof receipt.minimumFundingSompi !== "string" ||
      !/^[1-9][0-9]*$/.test(receipt.minimumFundingSompi) ||
      typeof receipt.ownerRecoveryFile !== "string" ||
      !path.isAbsolute(receipt.ownerRecoveryFile) ||
      path.resolve(receipt.ownerRecoveryFile) !== receipt.ownerRecoveryFile ||
      receipt.ownerRecoveryFile === "/" ||
      typeof receipt.activateCommand !== "string" ||
      !receipt.activateCommand.startsWith(
        "sudo sompi-operator bootstrap-activate ",
      ) ||
      !receipt.activateCommand.includes(expectedDigest) ||
      receipt.next !==
        "fund the displayed Testnet-10 funding address, then run activateCommand" ||
      !agentIsValid ||
      !Array.isArray(receipt.services) ||
      receipt.services.length !== 3 ||
      receipt.services[0] !== "sompi-authority" ||
      receipt.services[1] !== "sompi-api" ||
      receipt.services[2] !== "hermes-gateway"
    ) {
      throw new HostBootstrapError("host bootstrap commit receipt is invalid");
    }
  } finally {
    bytes?.fill(0);
    fs.closeSync(descriptor);
  }
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

function snapshotHermesConfig(ids: PrincipalIds): HermesConfigSnapshot {
  const filename = path.join(ids.agentHome, ".hermes", "config.yaml");
  if (!pathEntryExists(filename)) return { filename };
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== ids.agentUid ||
      stat.gid !== ids.agentGid ||
      (stat.mode & 0o022) !== 0 ||
      stat.size > 1024 * 1024
    ) {
      throw new HostBootstrapError("Hermes configuration is unsafe to snapshot");
    }
    return {
      filename,
      bytes: fs.readFileSync(descriptor),
      uid: stat.uid,
      gid: stat.gid,
      mode: stat.mode & 0o777,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function bindConfiguredHermesState(
  snapshot: HermesConfigSnapshot,
  ids: PrincipalIds,
): void {
  if (!pathEntryExists(snapshot.filename)) {
    if (snapshot.bytes) {
      throw new HostBootstrapError("Hermes configuration disappeared during installation");
    }
    snapshot.configuredAbsent = true;
    return;
  }
  const descriptor = fs.openSync(
    snapshot.filename,
    fs.constants.O_RDONLY | noFollowFlag(),
  );
  let bytes: Buffer | undefined;
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.uid !== BigInt(ids.agentUid) ||
      stat.gid !== BigInt(ids.agentGid) ||
      (stat.mode & 0o777n) !== 0o600n ||
      stat.size > 1024n * 1024n
    ) {
      throw new HostBootstrapError("configured Hermes state is unsafe");
    }
    bytes = fs.readFileSync(descriptor);
    snapshot.configuredIdentity = Object.freeze({
      dev: stat.dev,
      ino: stat.ino,
    });
    snapshot.configuredDigest = createHash("sha256").update(bytes).digest("hex");
  } finally {
    bytes?.fill(0);
    fs.closeSync(descriptor);
  }
}

function restoreHermesConfigStrict(
  snapshot: HermesConfigSnapshot,
  wasActive: boolean,
  ids: PrincipalIds,
  runner: HostCommandRunner,
): void {
  const agentUser = getPasswdById(ids.agentUid, runner).name;
  if (!snapshot.configurationAttempted) {
    reloadAndRestoreHermesService(wasActive, ids, runner);
    return;
  }
  if (snapshot.configuredAbsent && !snapshot.bytes) {
    reloadAndRestoreHermesService(wasActive, ids, runner);
    return;
  }
  if (!snapshot.configuredIdentity || !snapshot.configuredDigest) {
    throw new HostBootstrapError("configured Hermes state was not bound");
  }
  const bound = snapshot.configuredIdentity;
  if (!snapshot.bytes) {
    runHermesAgentFileOperation(
      agentUser,
      runner,
      "remove-bound-file",
      snapshot.filename,
      String(bound.dev),
      String(bound.ino),
      snapshot.configuredDigest,
    );
  } else {
    const temporaryDirectory = fs.mkdtempSync("/run/sompi-hermes-restore-");
    fs.chownSync(temporaryDirectory, 0, ids.agentGid);
    fs.chmodSync(temporaryDirectory, 0o710);
    const temporary = path.join(temporaryDirectory, "config.yaml");
    const bytes = Buffer.from(snapshot.bytes);
    try {
      writeExclusive(
        temporary,
        bytes,
        ids.agentUid,
        ids.agentGid,
        snapshot.mode ?? 0o600,
      );
      runHermesAgentFileOperation(
        agentUser,
        runner,
        "restore",
        temporary,
        snapshot.filename,
        String(snapshot.mode ?? 0o600),
        String(bound.dev),
        String(bound.ino),
        snapshot.configuredDigest,
      );
    } finally {
      bytes.fill(0);
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
  reloadAndRestoreHermesService(wasActive, ids, runner);
}

function reloadAndRestoreHermesService(
  wasActive: boolean,
  ids: PrincipalIds,
  runner: HostCommandRunner,
): void {
  if (wasActive) {
    restartHermes(ids, runner);
  } else {
    const environment = [`XDG_RUNTIME_DIR=/run/user/${ids.agentUid}`];
    runner.run("runuser", [
      "-u",
      getPasswdById(ids.agentUid, runner).name,
      "--",
      "env",
      ...environment,
      "systemctl",
      "--user",
      "daemon-reload",
    ]);
    runner.run("runuser", [
      "-u",
      getPasswdById(ids.agentUid, runner).name,
      "--",
      "env",
      ...environment,
      "systemctl",
      "--user",
      "stop",
      "hermes-gateway.service",
    ]);
  }
}

function prepareCredentialDirectory(directory: string, gid: number): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o750 });
  fs.chownSync(directory, 0, gid);
  fs.chmodSync(directory, 0o750);
}

function assertSafeAgentDirectory(directory: string, uid: number): void {
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new HostBootstrapError("Hermes agent directory is unsafe");
  }
}

function prepareAgentOwnedDirectoryTree(
  directory: string,
  ids: PrincipalIds,
  runner: HostCommandRunner,
  rollback: HostRollbackLedger,
): void {
  const relative = path.relative(ids.agentHome, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HostBootstrapError("Hermes integration directory is outside the selected agent home");
  }
  let current = ids.agentHome;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    if (!pathEntryExists(current)) {
      bindReportedAgentPath(rollback, runHermesAgentFileOperation(
        getPasswdById(ids.agentUid, runner).name,
        runner,
        "mkdir",
        current,
      ));
    }
    const stat = fs.lstatSync(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== ids.agentUid ||
      (stat.mode & 0o022) !== 0
    ) {
      throw new HostBootstrapError("Hermes integration directory is unsafe");
    }
  }
}

function prepareRuntimeDirectory(
  directory: string,
  uid: number,
  gid: number,
  mode = 0o710,
): void {
  fs.mkdirSync(directory, { recursive: true, mode });
  fs.chownSync(directory, uid, gid);
  fs.chmodSync(directory, mode);
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

function getPasswd(name: string, runner: HostCommandRunner): PasswdEntry;
function getPasswd(name: string, runner: HostCommandRunner, optional: true): PasswdEntry | undefined;
function getPasswd(name: string, runner: HostCommandRunner, optional = false): PasswdEntry | undefined {
  let output: string;
  try { output = runner.run("getent", ["passwd", name]); } catch (cause) {
    if (optional) return undefined;
    throw cause;
  }
  const fields = output.trim().split(":");
  if (fields.length !== 7 || fields[0] !== name) throw new HostBootstrapError("host user database returned invalid data");
  return {
    name,
    uid: numericId(fields[2]),
    gid: numericId(fields[3]),
    home: absolutePath(fields[5]),
    shell: absolutePath(fields[6]),
  };
}

function getPasswdById(uid: number, runner: HostCommandRunner): PasswdEntry {
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
  if (
    !value ||
    path.resolve(value) !== value ||
    value === path.parse(value).root ||
    /[\0\r\n"\\\s]/.test(value)
  ) {
    throw new HostBootstrapError("host absolute path is invalid");
  }
  return value;
}

function authorityIssuer(agentUser: string): string {
  return `urn:sompi:authority:${agentUser}`;
}

function fileContains(filename: string, needle: string): boolean {
  try { return fs.readFileSync(filename, "utf8").includes(needle); } catch { return false; }
}

function pathEntryExists(filename: string): boolean {
  try {
    fs.lstatSync(filename);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

function removeRollbackPath(
  filename: string,
  claim: RollbackPathClaim,
): void {
  if (!pathEntryExists(filename)) return;
  const stat = fs.lstatSync(filename, { bigint: true });
  if (
    !claim.identity ||
    stat.dev !== claim.identity.dev ||
    stat.ino !== claim.identity.ino ||
    stat.isSymbolicLink() !== claim.allowSymlink
  ) {
    throw new HostBootstrapError("Host Bootstrap rollback path was replaced");
  }
  if (claim.remove) {
    claim.remove(filename, claim);
    return;
  }
  if (claim.emptyOnly) {
    if (!stat.isDirectory()) {
      throw new HostBootstrapError("Host Bootstrap rollback parent was replaced");
    }
    fs.rmdirSync(filename);
    return;
  }
  if (!claim.inventory) {
    throw new HostBootstrapError("Host Bootstrap rollback path inventory is unavailable");
  }
  removeLocalRollbackInventory(filename, claim.inventory);
}

function captureLocalRollbackInventory(
  root: string,
): readonly AgentPathIdentity[] {
  const entries: AgentPathIdentity[] = [];
  const visit = (current: string, relative: string): void => {
    if (entries.length >= 100_000) {
      throw new HostBootstrapError("Host Bootstrap rollback inventory is too large");
    }
    const stat = fs.lstatSync(current, { bigint: true });
    const kind: AgentPathIdentity["kind"] = stat.isDirectory()
      ? "directory"
      : stat.isFile()
        ? "file"
        : stat.isSymbolicLink()
          ? "symlink"
          : (() => {
              throw new HostBootstrapError("Host Bootstrap rollback inventory contains an unsafe entry");
            })();
    entries.push(Object.freeze({
      relative,
      kind,
      dev: stat.dev,
      ino: stat.ino,
    }));
    if (kind === "directory") {
      for (const name of fs.readdirSync(current).sort()) {
        visit(path.join(current, name), relative ? path.join(relative, name) : name);
      }
    }
  };
  visit(root, "");
  return Object.freeze(entries);
}

function removeLocalRollbackInventory(
  root: string,
  inventory: readonly AgentPathIdentity[],
): void {
  const byRelative = new Map(inventory.map((entry) => [entry.relative, entry]));
  const matches = (filename: string, entry: AgentPathIdentity): boolean => {
    if (!pathEntryExists(filename)) return false;
    const stat = fs.lstatSync(filename, { bigint: true });
    const kind = stat.isDirectory()
      ? "directory"
      : stat.isFile()
        ? "file"
        : stat.isSymbolicLink()
          ? "symlink"
          : undefined;
    return (
      kind === entry.kind &&
      stat.dev === entry.dev &&
      stat.ino === entry.ino
    );
  };
  const ancestorsMatch = (relative: string): boolean => {
    const components = relative ? relative.split(path.sep) : [];
    let ancestorRelative = "";
    let ancestor = root;
    const rootEntry = byRelative.get("");
    if (!rootEntry || !matches(root, rootEntry)) return false;
    if (components.length === 0) return true;
    if (rootEntry.kind !== "directory") return false;
    for (const component of components.slice(0, -1)) {
      ancestorRelative = ancestorRelative
        ? path.join(ancestorRelative, component)
        : component;
      ancestor = path.join(ancestor, component);
      const entry = byRelative.get(ancestorRelative);
      if (
        !entry ||
        entry.kind !== "directory" ||
        !matches(ancestor, entry)
      ) {
        return false;
      }
    }
    return true;
  };
  const deepestFirst = [...inventory].sort((left, right) => {
    const depth = (value: AgentPathIdentity): number =>
      value.relative ? value.relative.split(path.sep).length : 0;
    return depth(right) - depth(left);
  });
  for (const entry of deepestFirst) {
    const target = entry.relative ? path.join(root, entry.relative) : root;
    if (!ancestorsMatch(entry.relative) || !matches(target, entry)) continue;
    if (entry.kind === "directory") {
      try {
        fs.rmdirSync(target);
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "EEXIST") throw cause;
      }
    } else {
      fs.unlinkSync(target);
    }
  }
  if (pathEntryExists(root)) {
    throw new HostBootstrapError(
      "Host Bootstrap rollback path contains untracked or replaced data",
    );
  }
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
