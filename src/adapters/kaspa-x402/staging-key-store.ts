import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { Keypair, PrivateKey } from "../../kaspa-wasm.js";
import { assertPurchaseId } from "../../purchase/identity.js";
import type { PurchaseId } from "../../purchase/types.js";
import { KaspaTestnet10AddressCodec } from "./address-codec.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_KEY_FILE_BYTES = 4096;
const NETWORK = "kaspa:testnet-10" as const;
const SDK_NETWORK = "testnet-10";
const REFERENCE_PATTERN = /^stg_v1_([A-Za-z0-9_-]{43})$/;
const PAYMENT_IDENTIFIER_PATTERN = /^pay_[A-Za-z0-9_-]{43}$/;
const PRIVATE_KEY_PATTERN = /^[a-f0-9]{64}$/;
const PUBLIC_KEY_PATTERN = /^[a-f0-9]{64}$/;

export interface StagingKeyBinding {
  readonly purchaseId: PurchaseId;
  readonly paymentIdentifier: string;
}

export interface StagingKeyLookup extends StagingKeyBinding {
  readonly keyReference: string;
}

/** Public, journal-safe metadata. The private key never crosses this boundary. */
export interface StagingKeyRecord extends StagingKeyLookup {
  readonly network: typeof NETWORK;
  readonly address: string;
  readonly publicKey: string;
  readonly scriptPublicKey: string;
  readonly createdAt: string;
}

export interface StagingKeyStoreOptions {
  readonly directory: string;
  readonly now?: () => number;
  /** Injectable only for deterministic vectors; production defaults to SDK CSPRNG. */
  readonly generatePrivateKey?: () => string;
}

interface PersistedStagingKey {
  readonly version: 1;
  readonly keyReference: string;
  readonly purchaseId: string;
  readonly paymentIdentifier: string;
  readonly network: typeof NETWORK;
  readonly privateKey: string;
  readonly createdAt: string;
}

interface ReadKeyResult {
  readonly persisted: PersistedStagingKey;
  readonly stat: fs.BigIntStats;
}

export class StagingKeyStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StagingKeyStoreError";
  }
}

/**
 * Attempt-scoped staging keys in an owner-only filesystem boundary.
 *
 * Creation is durable-before-return and no-clobber: a fully fsynced temporary
 * inode is hard-linked to its deterministic reference, then the temporary name
 * is removed. A concurrent creator either observes the same bound key or fails
 * closed on a collision; it never overwrites existing key material.
 */
export class StagingKeyStore {
  private readonly directory: string;
  private readonly directoryIdentity: { dev: bigint; ino: bigint };
  private readonly now: () => number;
  private readonly generatePrivateKey: () => string;
  private readonly addressCodec = new KaspaTestnet10AddressCodec();

  constructor(options: StagingKeyStoreOptions) {
    if (!options || typeof options.directory !== "string" || options.directory.length === 0) {
      throw new StagingKeyStoreError("staging key directory configuration is invalid");
    }
    this.directory = path.resolve(options.directory);
    this.now = options.now ?? Date.now;
    this.generatePrivateKey = options.generatePrivateKey ?? generateSdkPrivateKey;

    try {
      if (!pathExists(this.directory)) {
        fs.mkdirSync(this.directory, { recursive: true, mode: DIRECTORY_MODE });
        fs.chmodSync(this.directory, DIRECTORY_MODE);
      }
      const stat = secureDirectoryStat(this.directory);
      this.directoryIdentity = { dev: BigInt(stat.dev), ino: BigInt(stat.ino) };
      readClock(this.now);
    } catch (error) {
      if (error instanceof StagingKeyStoreError) throw error;
      throw new StagingKeyStoreError("could not initialize secure staging key directory", {
        cause: error,
      });
    }
  }

  create(binding: StagingKeyBinding): StagingKeyRecord {
    const normalized = normalizeBinding(binding);
    const keyReference = stagingKeyReference(normalized);
    const lookup = { ...normalized, keyReference };
    const existing = this.load(lookup);
    if (existing) return existing;

    const privateKey = normalizePrivateKey(this.generatePrivateKey());
    const createdAt = new Date(readClock(this.now)).toISOString();
    const persisted: PersistedStagingKey = {
      version: 1,
      keyReference,
      purchaseId: normalized.purchaseId,
      paymentIdentifier: normalized.paymentIdentifier,
      network: NETWORK,
      privateKey,
      createdAt,
    };
    const bytes = Buffer.from(`${JSON.stringify(persisted)}\n`, "utf8");
    const target = this.pathForReference(keyReference);
    const temporary = path.join(
      this.directory,
      `.${keyReference}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`
    );
    let temporaryExists = false;

    try {
      this.assertDirectoryUnchanged();
      const descriptor = fs.openSync(
        temporary,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          noFollowFlag(),
        FILE_MODE
      );
      temporaryExists = true;
      try {
        fs.fchmodSync(descriptor, FILE_MODE);
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }

      this.assertDirectoryUnchanged();
      try {
        fs.linkSync(temporary, target);
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
      }
      fs.unlinkSync(temporary);
      temporaryExists = false;
      fsyncDirectory(this.directory);

      const stored = this.recover(lookup);
      this.removeTemporaryFiles(keyReference);
      return stored;
    } catch (error) {
      if (temporaryExists) {
        try {
          fs.unlinkSync(temporary);
          fsyncDirectory(this.directory);
        } catch {
          // A stale owner-only temporary file is not addressable as a key
          // reference. Preserve the primary fail-closed error.
        }
      }
      if (error instanceof StagingKeyStoreError) throw error;
      throw new StagingKeyStoreError("could not durably create staging key", { cause: error });
    } finally {
      bytes.fill(0);
    }
  }

  load(lookup: StagingKeyLookup): StagingKeyRecord | undefined {
    const normalized = normalizeLookup(lookup);
    this.assertDirectoryUnchanged();
    const filename = this.pathForReference(normalized.keyReference);
    if (!pathExists(filename)) return undefined;
    this.repairInterruptedLink(normalized.keyReference);
    const read = this.readPersisted(normalized);
    return this.publicRecord(read.persisted);
  }

  /** Recovery requires the same deterministic binding and never creates a key. */
  recover(lookup: StagingKeyLookup): StagingKeyRecord {
    const record = this.load(lookup);
    if (!record) throw new StagingKeyStoreError("staging key is unavailable for recovery");
    return record;
  }

  /**
   * Loads one key for one operation and frees the SDK key object afterwards.
   * Callers receive no raw secret string and must not retain the SDK object.
   */
  async withPrivateKey<T>(
    lookup: StagingKeyLookup,
    operation: (privateKey: PrivateKey, record: StagingKeyRecord) => T | Promise<T>
  ): Promise<T> {
    if (typeof operation !== "function") {
      throw new StagingKeyStoreError("staging key operation is invalid");
    }
    const normalized = normalizeLookup(lookup);
    const { persisted } = this.readPersisted(normalized);
    let privateKey: PrivateKey | undefined;
    try {
      privateKey = new PrivateKey(persisted.privateKey);
      return await operation(privateKey, this.publicRecord(persisted));
    } finally {
      privateKey?.free();
    }
  }

  /** Delete is idempotent for a missing key but rejects a changed or misbound file. */
  delete(lookup: StagingKeyLookup): boolean {
    const normalized = normalizeLookup(lookup);
    this.assertDirectoryUnchanged();
    const filename = this.pathForReference(normalized.keyReference);
    if (!pathExists(filename)) return this.removeTemporaryFiles(normalized.keyReference);
    this.repairInterruptedLink(normalized.keyReference);
    const { stat } = this.readPersisted(normalized);
    const current = secureKeyStat(filename);
    if (current.dev !== stat.dev || current.ino !== stat.ino) {
      throw new StagingKeyStoreError("staging key changed before deletion");
    }
    fs.unlinkSync(filename);
    this.removeTemporaryFiles(normalized.keyReference);
    fsyncDirectory(this.directory);
    return true;
  }

  /** Repair only the store's own interrupted hard-link publication name. */
  private repairInterruptedLink(reference: string): void {
    const target = this.pathForReference(reference);
    const targetStat = fs.lstatSync(target, { bigint: true });
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) return;
    let changed = false;
    for (const entry of this.temporaryEntries(reference)) {
      const temporary = path.join(this.directory, entry);
      const stat = fs.lstatSync(temporary, { bigint: true });
      assertSecureTemporaryFile(stat);
      if (stat.dev === targetStat.dev && stat.ino === targetStat.ino) {
        fs.unlinkSync(temporary);
        changed = true;
      }
    }
    if (changed) fsyncDirectory(this.directory);
  }

  private removeTemporaryFiles(reference: string): boolean {
    let removed = false;
    for (const entry of this.temporaryEntries(reference)) {
      const temporary = path.join(this.directory, entry);
      const stat = fs.lstatSync(temporary, { bigint: true });
      assertSecureTemporaryFile(stat);
      fs.unlinkSync(temporary);
      removed = true;
    }
    if (removed) fsyncDirectory(this.directory);
    return removed;
  }

  private temporaryEntries(reference: string): string[] {
    requireReference(reference);
    const prefix = `.${reference}.`;
    return fs.readdirSync(this.directory).filter((entry) => {
      if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) return false;
      const middle = entry.slice(prefix.length, -".tmp".length);
      return /^(?:0|[1-9][0-9]*)\.[a-f0-9]{32}$/.test(middle);
    });
  }

  private readPersisted(lookup: StagingKeyLookup): ReadKeyResult {
    this.assertDirectoryUnchanged();
    const filename = this.pathForReference(lookup.keyReference);
    let descriptor: number | undefined;
    let bytes: Buffer | undefined;
    try {
      const before = secureKeyStat(filename);
      descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollowFlag());
      const opened = fs.fstatSync(descriptor, { bigint: true });
      assertSecureKeyFile(opened);
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new StagingKeyStoreError("staging key changed while opening");
      }
      if (opened.size <= 0n || opened.size > BigInt(MAX_KEY_FILE_BYTES)) {
        throw new StagingKeyStoreError("staging key file size is invalid");
      }
      bytes = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor, { bigint: true });
      assertSecureKeyFile(after);
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== BigInt(bytes.byteLength)
      ) {
        throw new StagingKeyStoreError("staging key changed while reading");
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const persisted = parsePersisted(text);
      assertPersistedBinding(persisted, lookup);
      // Derivation validates the scalar and every public fact before use.
      this.publicRecord(persisted);
      return { persisted, stat: after };
    } catch (error) {
      if (error instanceof StagingKeyStoreError) throw error;
      if (isErrno(error, "ENOENT")) {
        throw new StagingKeyStoreError("staging key is unavailable", { cause: error });
      }
      if (isErrno(error, "ELOOP")) {
        throw new StagingKeyStoreError("staging key file must not be a symbolic link", {
          cause: error,
        });
      }
      throw new StagingKeyStoreError("could not securely read staging key", { cause: error });
    } finally {
      bytes?.fill(0);
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  private publicRecord(persisted: PersistedStagingKey): StagingKeyRecord {
    let privateKey: PrivateKey | undefined;
    let keypair: Keypair | undefined;
    let address: ReturnType<PrivateKey["toAddress"]> | undefined;
    try {
      privateKey = new PrivateKey(persisted.privateKey);
      keypair = privateKey.toKeypair();
      const publicKey = String(keypair.xOnlyPublicKey).toLowerCase();
      if (!PUBLIC_KEY_PATTERN.test(publicKey)) {
        throw new StagingKeyStoreError("staging key public identity is invalid");
      }
      address = privateKey.toAddress(SDK_NETWORK);
      const addressText = address.toString();
      const scriptPublicKey = this.addressCodec.scriptPublicKeyForAddress(addressText, NETWORK);
      return Object.freeze({
        keyReference: persisted.keyReference,
        purchaseId: assertPurchaseId(persisted.purchaseId),
        paymentIdentifier: persisted.paymentIdentifier,
        network: NETWORK,
        address: addressText,
        publicKey,
        scriptPublicKey,
        createdAt: persisted.createdAt,
      });
    } catch (error) {
      if (error instanceof StagingKeyStoreError) throw error;
      throw new StagingKeyStoreError("staging key material is invalid", { cause: error });
    } finally {
      address?.free();
      keypair?.free();
      privateKey?.free();
    }
  }

  private pathForReference(reference: string): string {
    requireReference(reference);
    const filename = path.join(this.directory, `${reference}.key`);
    if (path.dirname(filename) !== this.directory) {
      throw new StagingKeyStoreError("staging key reference escaped its directory");
    }
    return filename;
  }

  private assertDirectoryUnchanged(): void {
    const stat = secureDirectoryStat(this.directory);
    if (
      BigInt(stat.dev) !== this.directoryIdentity.dev ||
      BigInt(stat.ino) !== this.directoryIdentity.ino
    ) {
      throw new StagingKeyStoreError("staging key directory identity changed");
    }
  }
}

export function stagingKeyReference(binding: StagingKeyBinding): string {
  const normalized = normalizeBinding(binding);
  const hash = createHash("sha256");
  appendLengthPrefixed(hash, "sompi:kaspa-x402:staging-key:v1");
  appendLengthPrefixed(hash, normalized.purchaseId);
  appendLengthPrefixed(hash, normalized.paymentIdentifier);
  return `stg_v1_${hash.digest("base64url")}`;
}

function normalizeBinding(binding: StagingKeyBinding): StagingKeyBinding {
  if (!binding || typeof binding !== "object") {
    throw new StagingKeyStoreError("staging key binding is invalid");
  }
  let purchaseId: PurchaseId;
  try {
    purchaseId = assertPurchaseId(binding.purchaseId);
  } catch {
    throw new StagingKeyStoreError("staging key Purchase identity is invalid");
  }
  if (!PAYMENT_IDENTIFIER_PATTERN.test(binding.paymentIdentifier)) {
    throw new StagingKeyStoreError("staging key payment identity is invalid");
  }
  return { purchaseId, paymentIdentifier: binding.paymentIdentifier };
}

function normalizeLookup(lookup: StagingKeyLookup): StagingKeyLookup {
  const binding = normalizeBinding(lookup);
  const keyReference = requireReference(lookup.keyReference);
  if (keyReference !== stagingKeyReference(binding)) {
    throw new StagingKeyStoreError("staging key reference is bound to different Purchase facts");
  }
  return { ...binding, keyReference };
}

function requireReference(value: unknown): string {
  if (typeof value !== "string" || !REFERENCE_PATTERN.test(value)) {
    throw new StagingKeyStoreError("staging key reference is invalid");
  }
  return value;
}

function normalizePrivateKey(value: unknown): string {
  if (typeof value !== "string" || !PRIVATE_KEY_PATTERN.test(value)) {
    throw new StagingKeyStoreError("generated staging private key is invalid");
  }
  let privateKey: PrivateKey | undefined;
  try {
    privateKey = new PrivateKey(value);
    if (privateKey.toString().toLowerCase() !== value) {
      throw new StagingKeyStoreError("generated staging private key is not canonical");
    }
    return value;
  } catch (error) {
    if (error instanceof StagingKeyStoreError) throw error;
    throw new StagingKeyStoreError("generated staging private key is invalid", { cause: error });
  } finally {
    privateKey?.free();
  }
}

function parsePersisted(text: string): PersistedStagingKey {
  let value: unknown;
  try {
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) throw new Error("invalid line");
    value = JSON.parse(text.slice(0, -1));
  } catch (error) {
    throw new StagingKeyStoreError("staging key file is malformed", { cause: error });
  }
  if (!isRecord(value)) throw new StagingKeyStoreError("staging key record is invalid");
  const keys = Object.keys(value).sort();
  const expected = [
    "createdAt",
    "keyReference",
    "network",
    "paymentIdentifier",
    "privateKey",
    "purchaseId",
    "version",
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new StagingKeyStoreError("staging key record contains unsupported fields");
  }
  if (
    value.version !== 1 ||
    value.network !== NETWORK ||
    typeof value.purchaseId !== "string" ||
    typeof value.paymentIdentifier !== "string" ||
    typeof value.keyReference !== "string" ||
    typeof value.privateKey !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    throw new StagingKeyStoreError("staging key record has invalid field types");
  }
  const time = Date.parse(value.createdAt);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value.createdAt) {
    throw new StagingKeyStoreError("staging key creation time is invalid");
  }
  normalizePrivateKey(value.privateKey);
  const persisted = value as unknown as PersistedStagingKey;
  if (`${JSON.stringify(persisted)}\n` !== text) {
    throw new StagingKeyStoreError("staging key record is not canonical");
  }
  return persisted;
}

function assertPersistedBinding(
  persisted: PersistedStagingKey,
  lookup: StagingKeyLookup
): void {
  if (
    persisted.purchaseId !== lookup.purchaseId ||
    persisted.paymentIdentifier !== lookup.paymentIdentifier ||
    persisted.keyReference !== lookup.keyReference ||
    persisted.keyReference !== stagingKeyReference(lookup)
  ) {
    throw new StagingKeyStoreError("staging key file collides with different Purchase facts");
  }
}

function generateSdkPrivateKey(): string {
  let keypair: Keypair | undefined;
  try {
    keypair = Keypair.random();
    return normalizePrivateKey(keypair.privateKey.toLowerCase());
  } finally {
    keypair?.free();
  }
}

function secureDirectoryStat(directory: string): fs.Stats {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new StagingKeyStoreError("staging key directory must be a real directory");
  }
  if ((stat.mode & 0o777) !== DIRECTORY_MODE) {
    throw new StagingKeyStoreError("staging key directory permissions must be 0700");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new StagingKeyStoreError("staging key directory must be owned by the current user");
  }
  return stat;
}

function secureKeyStat(filename: string): fs.BigIntStats {
  const stat = fs.lstatSync(filename, { bigint: true });
  assertSecureKeyFile(stat);
  return stat;
}

function assertSecureKeyFile(stat: fs.BigIntStats): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new StagingKeyStoreError("staging key path must be a regular file");
  }
  if ((Number(stat.mode) & 0o777) !== FILE_MODE) {
    throw new StagingKeyStoreError("staging key file permissions must be 0600");
  }
  if (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) {
    throw new StagingKeyStoreError("staging key file must be owned by the current user");
  }
  if (stat.nlink !== 1n) {
    throw new StagingKeyStoreError("staging key file must have exactly one filesystem link");
  }
}

function assertSecureTemporaryFile(stat: fs.BigIntStats): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new StagingKeyStoreError("staging key temporary path must be a regular file");
  }
  if ((Number(stat.mode) & 0o777) !== FILE_MODE) {
    throw new StagingKeyStoreError("staging key temporary file permissions must be 0600");
  }
  if (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) {
    throw new StagingKeyStoreError("staging key temporary file must be owned by the current user");
  }
  if (stat.nlink < 1n || stat.nlink > 2n) {
    throw new StagingKeyStoreError("staging key temporary file link count is invalid");
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | directoryFlag() | noFollowFlag()
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function appendLengthPrefixed(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  hash.update(length);
  hash.update(bytes);
}

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StagingKeyStoreError("staging key clock is invalid");
  }
  return value;
}

function pathExists(filename: string): boolean {
  try {
    fs.lstatSync(filename);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function noFollowFlag(): number {
  return fs.constants.O_NOFOLLOW ?? 0;
}

function directoryFlag(): number {
  return fs.constants.O_DIRECTORY ?? 0;
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
