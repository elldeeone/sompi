import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { EgressAllowRule } from "../purchase/egress-policy.js";
import type { Policy } from "../policy.js";
import { XOnlyPublicKey } from "../kaspa-wasm.js";
import { VAULT_TEMPLATE_VERSION } from "../vault/template.js";

export const OPERATOR_MANIFEST_SCHEMA = "sompi-operator-manifest-v2" as const;
export const MAX_OPERATOR_MANIFEST_BYTES = 64 * 1024;

const UINT64_MAX = (1n << 64n) - 1n;
const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

export type OperatorFinalityFloor = "accepted" | "depth-confirmed";

export interface OperatorManifestIdentity {
  readonly revision: number;
  readonly digest: string;
}

export interface OperatorManifest {
  readonly schema: typeof OPERATOR_MANIFEST_SCHEMA;
  readonly revision: number;
  readonly networkId: "testnet-10";
  readonly x402Network: "kaspa:testnet-10";
  readonly dataDirectory: string;
  readonly vault: Readonly<{
    template: string;
    ownerPublic: string;
    agentPublic: string;
    address: string;
    configDigest: string;
    maxOutflowSompi: string;
    windowSizeDaa: string;
  }>;
  readonly treasury: Readonly<{
    maxSompiPerTx: string;
    maxSompiPerHour: string;
    allowlist: readonly string[];
    requireApprovalAboveSompi: string;
    additionalCostCeilingAtomic: string;
    operationFeeCeilingAtomic: string;
  }>;
  readonly merchant: Readonly<{
    allowRules: readonly EgressAllowRule[];
  }>;
  readonly batch: Readonly<{
    claimFeeReserveAtomic: string;
  }>;
  readonly authority: Readonly<{
    provider: "terminal" | "telegram";
    telegram: null | Readonly<{
      profile: "telegram-inline-v1";
      botId: string;
      userId: string;
      chatId: string;
      promptTimeoutMs: number;
    }>;
  }>;
  readonly chainEvidence: Readonly<{
    operatorNodeUrl: string;
    witnessBaseUrl: string;
    depthConfirmationDaa: string;
    finalityFloors: Readonly<{
      settlement: OperatorFinalityFloor;
      directTreasury: OperatorFinalityFloor;
      vault: OperatorFinalityFloor;
      staging: OperatorFinalityFloor;
      recoveryRelease: OperatorFinalityFloor;
    }>;
  }>;
  readonly admission: Readonly<{
    authorityPreauthSockets: number;
    authorityPrompts: number;
    prevalidationPurchases: number;
    evidenceBytes: number;
    directTreasuryRetries: number;
  }>;
}

export interface LoadedOperatorManifest {
  readonly manifest: OperatorManifest;
  readonly identity: OperatorManifestIdentity;
  readonly filename: string;
}

export class OperatorManifestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OperatorManifestError";
  }
}

export function parseOperatorManifest(value: unknown): OperatorManifest {
  const root = record(value, "Operator Manifest");
  exactKeys(root, [
    "schema",
    "revision",
    "networkId",
    "x402Network",
    "dataDirectory",
    "vault",
    "treasury",
    "merchant",
    "batch",
    "authority",
    "chainEvidence",
    "admission",
  ], "Operator Manifest");
  if (root.schema !== OPERATOR_MANIFEST_SCHEMA) {
    throw new OperatorManifestError("Operator Manifest schema is unsupported");
  }
  const revision = positiveSafeInteger(root.revision, "Operator Manifest revision");
  if (root.networkId !== "testnet-10" || root.x402Network !== "kaspa:testnet-10") {
    throw new OperatorManifestError("Operator Manifest supports only testnet-10");
  }
  const dataDirectory = absolutePath(root.dataDirectory, "Operator Manifest data directory");

  const vault = record(root.vault, "Operator Manifest vault");
  exactKeys(vault, [
    "template",
    "ownerPublic",
    "agentPublic",
    "address",
    "configDigest",
    "maxOutflowSompi",
    "windowSizeDaa",
  ], "Operator Manifest vault");
  if (vault.template !== VAULT_TEMPLATE_VERSION) {
    throw new OperatorManifestError("Operator Manifest vault template is unsupported");
  }
  const ownerPublic = xOnlyPublicKey(vault.ownerPublic, "Operator Manifest owner public key");
  const agentPublic = xOnlyPublicKey(vault.agentPublic, "Operator Manifest Agent public key");
  const address = boundedString(vault.address, "Operator Manifest vault address", 256);
  if (!address.startsWith("kaspatest:")) {
    throw new OperatorManifestError("Operator Manifest vault address is not testnet");
  }
  const configDigest = digest(vault.configDigest, "Operator Manifest vault config digest");
  const maxOutflowSompi = positiveAtomic(vault.maxOutflowSompi, "Operator Manifest vault cap");
  const windowSizeDaa = positiveAtomic(vault.windowSizeDaa, "Operator Manifest vault window");

  const treasury = record(root.treasury, "Operator Manifest treasury");
  exactKeys(treasury, [
    "maxSompiPerTx",
    "maxSompiPerHour",
    "allowlist",
    "requireApprovalAboveSompi",
    "additionalCostCeilingAtomic",
    "operationFeeCeilingAtomic",
  ], "Operator Manifest treasury");
  const maxSompiPerTx = positiveAtomic(treasury.maxSompiPerTx, "per-payment policy limit");
  const maxSompiPerHour = positiveAtomic(treasury.maxSompiPerHour, "hourly policy limit");
  if (BigInt(maxSompiPerTx) > BigInt(maxSompiPerHour)) {
    throw new OperatorManifestError("per-payment policy limit exceeds hourly policy limit");
  }
  const allowlist = stringList(treasury.allowlist, "Treasury allowlist", 256, 256);
  const requireApprovalAboveSompi = atomic(
    treasury.requireApprovalAboveSompi,
    "approval threshold"
  );
  const additionalCostCeilingAtomic = atomic(
    treasury.additionalCostCeilingAtomic,
    "Purchase additional-cost ceiling"
  );
  const operationFeeCeilingAtomic = positiveAtomic(
    treasury.operationFeeCeilingAtomic,
    "Treasury operation fee ceiling"
  );

  const merchant = record(root.merchant, "Operator Manifest Merchant");
  exactKeys(merchant, ["allowRules"], "Operator Manifest Merchant");
  const allowRules = egressRules(merchant.allowRules);

  const batch = record(root.batch, "Operator Manifest batch settlement");
  exactKeys(batch, ["claimFeeReserveAtomic"], "Operator Manifest batch settlement");
  const claimFeeReserveAtomic = positiveAtomic(
    batch.claimFeeReserveAtomic,
    "batch claim-fee reserve"
  );

  const authority = record(root.authority, "Operator Manifest Authority");
  exactKeys(authority, ["provider", "telegram"], "Operator Manifest Authority");
  if (authority.provider !== "terminal" && authority.provider !== "telegram") {
    throw new OperatorManifestError("Operator Manifest Authority provider is unsupported");
  }
  let telegram: OperatorManifest["authority"]["telegram"] = null;
  if (authority.provider === "terminal") {
    if (authority.telegram !== null) {
      throw new OperatorManifestError("terminal Authority cannot configure Telegram");
    }
  } else {
    const configured = record(authority.telegram, "Operator Manifest Telegram Authority");
    exactKeys(configured, [
      "profile", "botId", "userId", "chatId", "promptTimeoutMs",
    ], "Operator Manifest Telegram Authority");
    if (configured.profile !== "telegram-inline-v1") {
      throw new OperatorManifestError("Operator Manifest Telegram Authority profile is unsupported");
    }
    const botId = telegramId(configured.botId, "Telegram bot ID", false);
    const userId = telegramId(configured.userId, "Telegram user ID", false);
    const chatId = telegramId(configured.chatId, "Telegram chat ID", true);
    const promptTimeoutMs = boundedCount(
      configured.promptTimeoutMs,
      "Telegram prompt timeout",
      300_000,
    );
    if (promptTimeoutMs < 10_000) {
      throw new OperatorManifestError("Telegram prompt timeout is below its minimum");
    }
    telegram = Object.freeze({
      profile: "telegram-inline-v1" as const,
      botId,
      userId,
      chatId,
      promptTimeoutMs,
    });
  }

  const chainEvidence = record(root.chainEvidence, "Operator Manifest Chain Evidence");
  exactKeys(chainEvidence, [
    "operatorNodeUrl",
    "witnessBaseUrl",
    "depthConfirmationDaa",
    "finalityFloors",
  ], "Operator Manifest Chain Evidence");
  const operatorNodeUrl = nodeUrl(chainEvidence.operatorNodeUrl);
  const witnessBaseUrl = witnessUrl(chainEvidence.witnessBaseUrl);
  const depthConfirmationDaa = positiveAtomic(
    chainEvidence.depthConfirmationDaa,
    "depth confirmation DAA"
  );
  const floors = record(chainEvidence.finalityFloors, "Operator Manifest finality floors");
  exactKeys(floors, [
    "settlement",
    "directTreasury",
    "vault",
    "staging",
    "recoveryRelease",
  ], "Operator Manifest finality floors");
  const finalityFloors = Object.freeze({
    settlement: finalityFloor(floors.settlement, "Settlement finality floor"),
    directTreasury: finalityFloor(floors.directTreasury, "direct Treasury finality floor"),
    vault: finalityFloor(floors.vault, "vault finality floor"),
    staging: finalityFloor(floors.staging, "staging finality floor"),
    recoveryRelease: finalityFloor(floors.recoveryRelease, "recovery-release finality floor"),
  });

  const admission = record(root.admission, "Operator Manifest admission");
  exactKeys(admission, [
    "authorityPreauthSockets",
    "authorityPrompts",
    "prevalidationPurchases",
    "evidenceBytes",
    "directTreasuryRetries",
  ], "Operator Manifest admission");
  const normalizedAdmission = Object.freeze({
    authorityPreauthSockets: boundedCount(admission.authorityPreauthSockets, "Authority pre-authentication sockets", 1_024),
    authorityPrompts: boundedCount(admission.authorityPrompts, "Authority prompts", 128),
    prevalidationPurchases: boundedCount(admission.prevalidationPurchases, "pre-validation Purchases", 10_000),
    evidenceBytes: boundedCount(admission.evidenceBytes, "evidence bytes", 1_073_741_824),
    directTreasuryRetries: boundedCount(admission.directTreasuryRetries, "direct Treasury retries", 128),
  });

  return deepFreeze({
    schema: OPERATOR_MANIFEST_SCHEMA,
    revision,
    networkId: "testnet-10",
    x402Network: "kaspa:testnet-10",
    dataDirectory,
    vault: {
      template: VAULT_TEMPLATE_VERSION,
      ownerPublic,
      agentPublic,
      address,
      configDigest,
      maxOutflowSompi,
      windowSizeDaa,
    },
    treasury: {
      maxSompiPerTx,
      maxSompiPerHour,
      allowlist,
      requireApprovalAboveSompi,
      additionalCostCeilingAtomic,
      operationFeeCeilingAtomic,
    },
    merchant: { allowRules },
    batch: { claimFeeReserveAtomic },
    authority: { provider: authority.provider, telegram },
    chainEvidence: {
      operatorNodeUrl,
      witnessBaseUrl,
      depthConfirmationDaa,
      finalityFloors,
    },
    admission: normalizedAdmission,
  });
}

export function canonicalOperatorManifestBytes(value: unknown): Buffer {
  const manifest = parseOperatorManifest(value);
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function operatorManifestIdentity(value: OperatorManifest): OperatorManifestIdentity {
  const bytes = canonicalOperatorManifestBytes(value);
  try {
    return Object.freeze({
      revision: value.revision,
      digest: `sha256:${createHash("sha256").update(bytes).digest("base64url")}`,
    });
  } finally {
    bytes.fill(0);
  }
}

export function operatorPolicy(manifest: OperatorManifest): Policy {
  return Object.freeze({
    maxSompiPerTx: BigInt(manifest.treasury.maxSompiPerTx),
    maxSompiPerHour: BigInt(manifest.treasury.maxSompiPerHour),
    allowlist: Object.freeze([...manifest.treasury.allowlist]) as unknown as string[],
    requireApprovalAboveSompi: BigInt(manifest.treasury.requireApprovalAboveSompi),
  });
}

export function loadOperatorManifest(
  filename: string,
  options: Readonly<{
    expectedOperatorUserId: number;
    runtimeGroupId: number;
    allowSameUserForTests?: boolean;
    readerRole?: "runtime" | "operator";
  }>
): LoadedOperatorManifest {
  const resolved = absolutePath(filename, "Operator Manifest path");
  const expectedUid = numericId(options.expectedOperatorUserId, "operator user ID");
  const runtimeGid = numericId(options.runtimeGroupId, "runtime group ID");
  const currentUid = typeof process.getuid === "function" ? process.getuid() : expectedUid + 1;
  const readerRole = options.readerRole ?? "runtime";
  if (!options.allowSameUserForTests) {
    if (readerRole === "runtime" && currentUid === expectedUid) {
      throw new OperatorManifestError("Operator Manifest owner must differ from the MCP runtime user");
    }
    if (readerRole === "operator" && currentUid !== 0 && currentUid !== expectedUid) {
      throw new OperatorManifestError("Operator Manifest inspection requires root or its declared owner");
    }
  }
  let descriptor: number | undefined;
  let bytes: Buffer | undefined;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollowFlag());
    const before = fs.fstatSync(descriptor);
    const expectedMode = options.allowSameUserForTests ? 0o600 : 0o640;
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== expectedUid ||
      (!options.allowSameUserForTests && before.gid !== runtimeGid) ||
      (before.mode & 0o777) !== expectedMode ||
      before.size < 2 ||
      before.size > MAX_OPERATOR_MANIFEST_BYTES
    ) {
      throw new OperatorManifestError("Operator Manifest ownership, mode, link count, type, or size is unsafe");
    }
    assertManifestDirectory(resolved, expectedUid, runtimeGid, options.allowSameUserForTests === true);
    bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new OperatorManifestError("Operator Manifest was truncated during read");
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(resolved);
    if (
      !after.isFile() ||
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      after.dev !== pathStat.dev ||
      after.ino !== pathStat.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new OperatorManifestError("Operator Manifest changed during its stable read");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new OperatorManifestError("Operator Manifest JSON is malformed", { cause });
    }
    const manifest = parseOperatorManifest(parsed);
    const canonical = canonicalOperatorManifestBytes(manifest);
    try {
      if (!canonical.equals(bytes)) {
        throw new OperatorManifestError("Operator Manifest bytes are not canonical");
      }
    } finally {
      canonical.fill(0);
    }
    return Object.freeze({
      manifest,
      identity: operatorManifestIdentity(manifest),
      filename: resolved,
    });
  } catch (cause) {
    if (cause instanceof OperatorManifestError) throw cause;
    throw new OperatorManifestError("Operator Manifest could not be loaded securely", { cause });
  } finally {
    bytes?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** Test-only publisher; production installation is owned by sompi-operator. */
export function publishOperatorManifestForTests(filename: string, value: unknown): LoadedOperatorManifest {
  const resolved = absolutePath(filename, "Operator Manifest test path");
  const directory = path.dirname(resolved);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const bytes = canonicalOperatorManifestBytes(value);
  try {
    fs.writeFileSync(resolved, bytes, { mode: 0o600, flag: "wx" });
  } finally {
    bytes.fill(0);
  }
  return loadOperatorManifest(resolved, {
    expectedOperatorUserId: typeof process.getuid === "function" ? process.getuid() : 0,
    runtimeGroupId: typeof process.getgid === "function" ? process.getgid() : 0,
    allowSameUserForTests: true,
  });
}

function assertManifestDirectory(filename: string, uid: number, gid: number, testMode: boolean): void {
  const directory = path.dirname(filename);
  const stat = fs.lstatSync(directory);
  const expectedMode = testMode ? 0o700 : 0o750;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (!testMode && stat.gid !== gid) ||
    (stat.mode & 0o777) !== expectedMode
  ) {
    throw new OperatorManifestError("Operator Manifest directory ownership or mode is unsafe");
  }
  if (testMode) return;
  let ancestor = path.dirname(directory);
  while (true) {
    const ancestorStat = fs.lstatSync(ancestor);
    if (
      !ancestorStat.isDirectory() || ancestorStat.isSymbolicLink() ||
      (ancestorStat.mode & 0o022) !== 0
    ) {
      throw new OperatorManifestError("Operator Manifest ancestor is symlinked or writable by an untrusted principal");
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
}

function egressRules(value: unknown): readonly EgressAllowRule[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    throw new OperatorManifestError("Operator Manifest Merchant rules must contain 1 to 128 entries");
  }
  const hosts = new Set<string>();
  return Object.freeze(value.map((entry, index) => {
    const rule = record(entry, `Merchant rule ${index}`);
    exactKeys(rule, ["hostname", "ports"], `Merchant rule ${index}`);
    const hostname = boundedString(rule.hostname, `Merchant rule ${index} hostname`, 253).toLowerCase().replace(/\.$/, "");
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) {
      throw new OperatorManifestError(`Merchant rule ${index} hostname is invalid`);
    }
    if (hosts.has(hostname)) throw new OperatorManifestError("Operator Manifest Merchant host is duplicated");
    hosts.add(hostname);
    if (!Array.isArray(rule.ports) || rule.ports.length < 1 || rule.ports.length > 32) {
      throw new OperatorManifestError(`Merchant rule ${index} ports are invalid`);
    }
    const ports = rule.ports.map((port) => positiveSafeInteger(port, `Merchant rule ${index} port`));
    if (ports.some((port) => port > 65_535) || new Set(ports).size !== ports.length) {
      throw new OperatorManifestError(`Merchant rule ${index} ports are invalid or duplicated`);
    }
    const sorted = [...ports].sort((left, right) => left - right);
    if (JSON.stringify(sorted) !== JSON.stringify(ports)) {
      throw new OperatorManifestError(`Merchant rule ${index} ports are not canonical`);
    }
    return Object.freeze({ hostname, ports: Object.freeze(ports) });
  }));
}

function nodeUrl(value: unknown): string {
  return exactUrl(value, "Kaspa operator node URL", new Set(["ws:", "wss:"]));
}

function witnessUrl(value: unknown): string {
  return exactUrl(value, "Kaspa witness URL", new Set(["https:"]));
}

function exactUrl(value: unknown, label: string, protocols: ReadonlySet<string>): string {
  const raw = boundedString(value, label, 2048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    throw new OperatorManifestError(`${label} is invalid`, { cause });
  }
  if (
    !protocols.has(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new OperatorManifestError(`${label} has an unsafe scheme or authority`);
  }
  return parsed.href;
}

function finalityFloor(value: unknown, label: string): OperatorFinalityFloor {
  if (value !== "accepted" && value !== "depth-confirmed") {
    throw new OperatorManifestError(`${label} is unsupported`);
  }
  return value;
}

function xOnlyPublicKey(value: unknown, label: string): string {
  const text = boundedString(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(text)) throw new OperatorManifestError(`${label} is noncanonical`);
  let key: XOnlyPublicKey | undefined;
  try {
    key = new XOnlyPublicKey(text);
    if (key.toString() !== text) throw new Error("noncanonical x-only key");
    return text;
  } catch (cause) {
    throw new OperatorManifestError(`${label} is invalid`, { cause });
  } finally {
    key?.free();
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new OperatorManifestError(`${label} has unknown or missing fields`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OperatorManifestError(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new OperatorManifestError(`${label} is invalid`);
  }
  return value;
}

function identity(value: unknown, label: string): string {
  const text = boundedString(value, label, 256);
  if (!ID_PATTERN.test(text)) throw new OperatorManifestError(`${label} is invalid`);
  return text;
}

function digest(value: unknown, label: string): string {
  const text = boundedString(value, label, 50);
  if (!DIGEST_PATTERN.test(text)) throw new OperatorManifestError(`${label} is invalid`);
  return text;
}

function atomic(value: unknown, label: string): string {
  const text = boundedString(value, label, 20);
  if (!/^(?:0|[1-9][0-9]*)$/.test(text) || BigInt(text) > UINT64_MAX) {
    throw new OperatorManifestError(`${label} is invalid`);
  }
  return text;
}

function positiveAtomic(value: unknown, label: string): string {
  const text = atomic(value, label);
  if (text === "0") throw new OperatorManifestError(`${label} must be positive`);
  return text;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new OperatorManifestError(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function boundedCount(value: unknown, label: string, maximum: number): number {
  const count = positiveSafeInteger(value, label);
  if (count > maximum) throw new OperatorManifestError(`${label} exceeds its maximum`);
  return count;
}

function telegramId(value: unknown, label: string, allowNegative: boolean): string {
  const text = boundedString(value, label, 21);
  const pattern = allowNegative ? /^-?[1-9][0-9]{0,19}$/ : /^[1-9][0-9]{0,19}$/;
  if (!pattern.test(text)) throw new OperatorManifestError(`${label} is invalid`);
  return text;
}

function numericId(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 0x7fffffff) {
    throw new OperatorManifestError(`${label} is invalid`);
  }
  return Number(value);
}

function stringList(value: unknown, label: string, maximum: number, itemBytes: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new OperatorManifestError(`${label} is invalid`);
  }
  const items = value.map((item, index) => boundedString(item, `${label} item ${index}`, itemBytes));
  if (new Set(items).size !== items.length) throw new OperatorManifestError(`${label} has duplicates`);
  const sorted = [...items].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(items)) {
    throw new OperatorManifestError(`${label} is not canonical`);
  }
  return Object.freeze(items);
}

function absolutePath(value: unknown, label: string): string {
  const text = boundedString(value, label, 4096);
  if (!path.isAbsolute(text) || path.resolve(text) !== text) {
    throw new OperatorManifestError(`${label} must be canonical and absolute`);
  }
  return text;
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
