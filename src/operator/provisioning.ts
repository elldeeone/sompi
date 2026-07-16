import * as fs from "node:fs";
import * as path from "node:path";

import {
  OPERATOR_MANIFEST_SCHEMA,
  canonicalOperatorManifestBytes,
  loadOperatorManifest,
  operatorManifestIdentity,
  parseOperatorManifest,
  type LoadedOperatorManifest,
  type OperatorManifest,
} from "./manifest.js";
import {
  VaultManager,
  vaultStaticConfigurationDigest,
} from "../vault.js";
import { VAULT_TEMPLATE_VERSION } from "../vault/template.js";

export const OPERATOR_PROVISIONING_SCHEMA = "sompi-operator-provisioning-v1" as const;
const MAX_SPEC_BYTES = 64 * 1024;

export interface OperatorProvisioningSpec {
  readonly schema: typeof OPERATOR_PROVISIONING_SCHEMA;
  readonly revision: number;
  readonly dataDirectory: string;
  readonly ownerPublic: string;
  readonly maxOutflowSompi: string;
  readonly windowSizeDaa: string;
  readonly treasury: OperatorManifest["treasury"];
  readonly merchant: OperatorManifest["merchant"];
  readonly batch: OperatorManifest["batch"];
  readonly chainEvidence: OperatorManifest["chainEvidence"];
  readonly admission: OperatorManifest["admission"];
}

export interface ProvisionedOperatorCandidate {
  readonly bundleDirectory: string;
  readonly manifest: OperatorManifest;
  readonly revision: number;
  readonly digest: string;
  readonly vaultAddress: string;
}

export interface OperatorInstallOptions {
  readonly operatorUserId: number;
  readonly runtimeUserId: number;
  readonly runtimeGroupId: number;
  /** Internal hermetic-test capability; never exposed by the production CLI. */
  readonly allowSameUserForTests?: boolean;
}

export class OperatorProvisioningError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OperatorProvisioningError";
  }
}

export function loadOperatorProvisioningSpec(filename: string): OperatorProvisioningSpec {
  const resolved = path.resolve(filename);
  let descriptor: number | undefined;
  let bytes: Buffer | undefined;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollowFlag());
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > MAX_SPEC_BYTES) {
      throw new OperatorProvisioningError("operator provisioning spec is not a bounded regular file");
    }
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new OperatorProvisioningError("operator provisioning spec was truncated");
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    const pathname = fs.lstatSync(resolved);
    if (
      pathname.isSymbolicLink() || !pathname.isFile() || before.dev !== after.dev ||
      before.ino !== after.ino || after.dev !== pathname.dev || after.ino !== pathname.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    ) {
      throw new OperatorProvisioningError("operator provisioning spec changed during stable read");
    }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    return parseOperatorProvisioningSpec(value);
  } catch (cause) {
    if (cause instanceof OperatorProvisioningError) throw cause;
    throw new OperatorProvisioningError("operator provisioning spec could not be loaded", { cause });
  } finally {
    bytes?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function parseOperatorProvisioningSpec(value: unknown): OperatorProvisioningSpec {
  const candidate = requireRecord(value, "operator provisioning spec");
  requireExactKeys(candidate, [
    "schema", "revision", "dataDirectory", "ownerPublic", "maxOutflowSompi",
    "windowSizeDaa", "treasury", "merchant", "batch", "chainEvidence", "admission",
  ]);
  if (candidate.schema !== OPERATOR_PROVISIONING_SCHEMA) {
    throw new OperatorProvisioningError("operator provisioning schema is unsupported");
  }
  // Reuse the canonical manifest validator with a temporary, valid generated-key
  // placeholder. Real generated facts replace it during provision.
  const placeholder = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
  const dataDirectory = requireAbsolutePath(candidate.dataDirectory);
  const manifest = parseOperatorManifest({
    schema: OPERATOR_MANIFEST_SCHEMA,
    revision: candidate.revision,
    networkId: "testnet-10",
    x402Network: "kaspa:testnet-10",
    dataDirectory,
    vault: {
      template: VAULT_TEMPLATE_VERSION,
      ownerPublic: candidate.ownerPublic,
      agentPublic: placeholder,
      address: "kaspatest:qplaceholder",
      configDigest: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      maxOutflowSompi: candidate.maxOutflowSompi,
      windowSizeDaa: candidate.windowSizeDaa,
    },
    treasury: candidate.treasury,
    merchant: candidate.merchant,
    batch: candidate.batch,
    chainEvidence: candidate.chainEvidence,
    admission: candidate.admission,
  });
  return Object.freeze({
    schema: OPERATOR_PROVISIONING_SCHEMA,
    revision: manifest.revision,
    dataDirectory,
    ownerPublic: manifest.vault.ownerPublic,
    maxOutflowSompi: manifest.vault.maxOutflowSompi,
    windowSizeDaa: manifest.vault.windowSizeDaa,
    treasury: manifest.treasury,
    merchant: manifest.merchant,
    batch: manifest.batch,
    chainEvidence: manifest.chainEvidence,
    admission: manifest.admission,
  });
}

/** Validate and summarize without generating keys or writing state. */
export function previewOperatorProvisioning(spec: OperatorProvisioningSpec): Readonly<Record<string, unknown>> {
  const validated = parseOperatorProvisioningSpec(spec);
  return Object.freeze({
    schema: validated.schema,
    revision: validated.revision,
    networkId: "testnet-10",
    dataDirectory: validated.dataDirectory,
    ownerPublic: validated.ownerPublic,
    vaultCapSompi: validated.maxOutflowSompi,
    vaultWindowDaa: validated.windowSizeDaa,
    operatorNodeUrl: validated.chainEvidence.operatorNodeUrl,
    witnessBaseUrl: validated.chainEvidence.witnessBaseUrl,
    finalityFloors: validated.chainEvidence.finalityFloors,
  });
}

/** Create a sealed candidate bundle. It cannot be used by the MCP runtime. */
export function provisionOperatorCandidate(
  specInput: OperatorProvisioningSpec,
  bundleDirectory: string
): ProvisionedOperatorCandidate {
  const spec = parseOperatorProvisioningSpec(specInput);
  const bundle = path.resolve(bundleDirectory);
  if (fs.existsSync(bundle)) throw new OperatorProvisioningError("candidate bundle already exists");
  fs.mkdirSync(bundle, { recursive: false, mode: 0o700 });
  fs.chmodSync(bundle, 0o700);
  const candidateData = path.join(bundle, "runtime-data");
  try {
    const vault = new VaultManager(candidateData, "testnet-10");
    const config = vault.create(
      BigInt(spec.maxOutflowSompi),
      spec.ownerPublic,
      BigInt(spec.windowSizeDaa)
    );
    const manifest = parseOperatorManifest({
      schema: OPERATOR_MANIFEST_SCHEMA,
      revision: spec.revision,
      networkId: "testnet-10",
      x402Network: "kaspa:testnet-10",
      dataDirectory: spec.dataDirectory,
      vault: {
        template: config.template,
        ownerPublic: config.ownerPublic,
        agentPublic: config.agentPublic,
        address: config.address,
        configDigest: vaultStaticConfigurationDigest(config),
        maxOutflowSompi: config.maxOutflowSompi,
        windowSizeDaa: config.windowSizeDaa,
      },
      treasury: spec.treasury,
      merchant: spec.merchant,
      batch: spec.batch,
      chainEvidence: spec.chainEvidence,
      admission: spec.admission,
    });
    const bytes = canonicalOperatorManifestBytes(manifest);
    try {
      writeExclusiveDurable(path.join(bundle, "manifest.candidate.json"), bytes, 0o600);
    } finally {
      bytes.fill(0);
    }
    const identity = operatorManifestIdentity(manifest);
    const receipt = Buffer.from(`${JSON.stringify({
      schema: "sompi-operator-candidate-v1",
      revision: identity.revision,
      digest: identity.digest,
      vaultAddress: manifest.vault.address,
    }, null, 2)}\n`, "utf8");
    try {
      writeExclusiveDurable(path.join(bundle, "receipt.json"), receipt, 0o600);
    } finally {
      receipt.fill(0);
    }
    fsyncDirectory(bundle);
    return Object.freeze({
      bundleDirectory: bundle,
      manifest,
      revision: identity.revision,
      digest: identity.digest,
      vaultAddress: manifest.vault.address,
    });
  } catch (cause) {
    fs.rmSync(bundle, { recursive: true, force: true });
    if (cause instanceof OperatorProvisioningError) throw cause;
    throw new OperatorProvisioningError("operator candidate provisioning failed", { cause });
  }
}

export function installOperatorCandidate(
  bundleDirectory: string,
  manifestFilename: string,
  expectedDigest: string,
  options: OperatorInstallOptions
): LoadedOperatorManifest {
  const bundle = path.resolve(bundleDirectory);
  const manifestPath = path.resolve(manifestFilename);
  const candidatePath = path.join(bundle, "manifest.candidate.json");
  const candidateBytes = fs.readFileSync(candidatePath);
  let manifest: OperatorManifest;
  try {
    manifest = parseOperatorManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(candidateBytes)));
    const canonical = canonicalOperatorManifestBytes(manifest);
    try {
      if (!canonical.equals(candidateBytes)) throw new OperatorProvisioningError("candidate manifest is not canonical");
    } finally {
      canonical.fill(0);
    }
  } finally {
    candidateBytes.fill(0);
  }
  const identity = operatorManifestIdentity(manifest);
  if (identity.digest !== expectedDigest) throw new OperatorProvisioningError("candidate digest does not match preview approval");
  validateInstallIds(options);
  if (fs.existsSync(manifest.dataDirectory) || fs.existsSync(manifestPath)) {
    throw new OperatorProvisioningError("installation target already exists; funded state is never replaced");
  }
  const candidateData = path.join(bundle, "runtime-data");
  const vault = new VaultManager(candidateData, "testnet-10");
  const config = vault.config();
  if (
    vaultStaticConfigurationDigest(config) !== manifest.vault.configDigest ||
    vault.initialAddress() !== manifest.vault.address ||
    config.agentPublic !== manifest.vault.agentPublic ||
    config.ownerPublic !== manifest.vault.ownerPublic
  ) {
    throw new OperatorProvisioningError("candidate vault facts do not match the approved manifest");
  }
  fs.mkdirSync(path.dirname(manifest.dataDirectory), { recursive: true, mode: 0o700 });
  fs.renameSync(candidateData, manifest.dataDirectory);
  chownTree(manifest.dataDirectory, options.runtimeUserId, options.runtimeGroupId);
  const testMode = options.allowSameUserForTests === true;
  const directory = path.dirname(manifestPath);
  fs.mkdirSync(directory, { recursive: true, mode: testMode ? 0o700 : 0o750 });
  fs.chownSync(directory, options.operatorUserId, options.runtimeGroupId);
  fs.chmodSync(directory, testMode ? 0o700 : 0o750);
  const bytes = canonicalOperatorManifestBytes(manifest);
  try {
    writeExclusiveDurable(manifestPath, bytes, testMode ? 0o600 : 0o640);
    fs.chownSync(manifestPath, options.operatorUserId, options.runtimeGroupId);
    fs.chmodSync(manifestPath, testMode ? 0o600 : 0o640);
    fsyncDirectory(directory);
  } finally {
    bytes.fill(0);
  }
  return loadOperatorManifest(manifestPath, {
    expectedOperatorUserId: options.operatorUserId,
    runtimeGroupId: options.runtimeGroupId,
    allowSameUserForTests: testMode,
  });
}

export function operatorProvisioningStatus(
  manifestFilename: string,
  options: Pick<OperatorInstallOptions, "operatorUserId" | "runtimeGroupId" | "allowSameUserForTests">
): Readonly<Record<string, unknown>> {
  const loaded = loadOperatorManifest(manifestFilename, {
    expectedOperatorUserId: options.operatorUserId,
    runtimeGroupId: options.runtimeGroupId,
    allowSameUserForTests: options.allowSameUserForTests,
  });
  const vault = new VaultManager(loaded.manifest.dataDirectory, "testnet-10");
  const config = vault.config();
  const matches = vaultStaticConfigurationDigest(config) === loaded.manifest.vault.configDigest &&
    vault.initialAddress() === loaded.manifest.vault.address &&
    config.agentPublic === loaded.manifest.vault.agentPublic &&
    config.ownerPublic === loaded.manifest.vault.ownerPublic;
  if (!matches) throw new OperatorProvisioningError("installed vault differs from Operator Manifest");
  return Object.freeze({
    status: "ready",
    revision: loaded.identity.revision,
    digest: loaded.identity.digest,
    networkId: loaded.manifest.networkId,
    dataDirectory: loaded.manifest.dataDirectory,
    vaultAddress: loaded.manifest.vault.address,
  });
}

function validateInstallIds(options: OperatorInstallOptions): void {
  for (const [label, value] of Object.entries({
    operatorUserId: options.operatorUserId,
    runtimeUserId: options.runtimeUserId,
    runtimeGroupId: options.runtimeGroupId,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new OperatorProvisioningError(`${label} is invalid`);
  }
  const current = typeof process.getuid === "function" ? process.getuid() : options.operatorUserId;
  if (current !== 0 && current !== options.operatorUserId) {
    throw new OperatorProvisioningError("sompi-operator must run as root or the declared operator user");
  }
  if (!options.allowSameUserForTests && options.operatorUserId === options.runtimeUserId) {
    throw new OperatorProvisioningError("operator and MCP runtime users must be distinct");
  }
}

function chownTree(root: string, uid: number, gid: number): void {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) throw new OperatorProvisioningError("runtime state contains a symbolic link");
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(root)) chownTree(path.join(root, entry), uid, gid);
    fs.chownSync(root, uid, gid);
    fs.chmodSync(root, 0o700);
    return;
  }
  if (!stat.isFile() || stat.nlink !== 1) throw new OperatorProvisioningError("runtime state contains an unsafe entry");
  fs.chownSync(root, uid, gid);
  fs.chmodSync(root, 0o600);
}

function writeExclusiveDurable(filename: string, bytes: Buffer, mode: number): void {
  const descriptor = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag(), mode);
  try {
    fs.fchmodSync(descriptor, mode);
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OperatorProvisioningError(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new OperatorProvisioningError("operator provisioning spec has unknown or missing fields");
  }
}

function requireAbsolutePath(value: unknown): string {
  if (typeof value !== "string" || value !== path.resolve(value) || value === path.parse(value).root) {
    throw new OperatorProvisioningError("runtime data directory must be an absolute non-root path");
  }
  return value;
}

function noFollowFlag(): number {
  return (fs.constants as unknown as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
}
