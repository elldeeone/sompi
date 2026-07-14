import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_LEAF_NAME_BYTES = 128;
const TEMPORARY_SUFFIX_PATTERN = /\.(?:create|replace)-(?:0|[1-9][0-9]*)-[a-f0-9]{32}\.tmp$/;

export class SecureLocalStateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SecureLocalStateError";
  }
}

/**
 * A small filesystem boundary for Sompi-owned local state.
 *
 * The directory identity is pinned for the lifetime of this object. Files are
 * owner-only, single-link regular files and every read compares the lstat,
 * opened descriptor, and final path identity. Immutable secrets are published
 * through an exclusive hard-link only after their bytes have been fsynced;
 * replaceable state is written to a fsynced temporary inode and atomically
 * renamed before the directory is fsynced.
 */
export class SecureLocalStateDirectory {
  readonly directory: string;
  private readonly label: string;
  private readonly identity: FileIdentity;
  private readonly expectedUid: bigint;

  constructor(directory: string, label = "local state") {
    if (typeof directory !== "string" || directory.length === 0) {
      throw new SecureLocalStateError(`${label} directory is invalid`);
    }
    this.directory = path.resolve(directory);
    this.label = safeLabel(label);

    try {
      assertNoSymlinkComponents(this.directory, this.label);
      const existed = pathExists(this.directory);
      if (!existed) {
        fs.mkdirSync(this.directory, { recursive: true, mode: DIRECTORY_MODE });
        fsyncDirectoryEntry(path.dirname(this.directory));
      }
      assertCanonicalRealpath(this.directory, this.label);
      const stat = fs.lstatSync(this.directory, { bigint: true });
      this.expectedUid = currentUid(stat.uid);
      assertSecureDirectory(stat, this.expectedUid, this.label);
      this.identity = identityOf(stat);
      this.assertDirectoryUnchanged();
    } catch (error) {
      if (error instanceof SecureLocalStateError) throw error;
      throw new SecureLocalStateError(`${this.label} directory is unavailable`, {
        cause: error,
      });
    }
  }

  child(name: string, label = `${this.label} child`): SecureLocalStateDirectory {
    const leaf = requireLeafName(name);
    this.assertDirectoryUnchanged();
    const child = new SecureLocalStateDirectory(path.join(this.directory, leaf), label);
    this.assertDirectoryUnchanged();
    return child;
  }

  fileExists(name: string): boolean {
    const filename = this.filePath(name);
    this.assertDirectoryUnchanged();
    this.removeInterruptedTemporaryFiles(name);
    if (!pathExists(filename)) return false;
    secureFileStat(filename, this.expectedUid, this.label);
    return true;
  }

  /**
   * Durably publish an empty regular file without replacing an existing path.
   *
   * SQLite needs an empty pathname before it writes the first database header;
   * keeping this operation separate from secret publication preserves the
   * non-empty invariant of `createFileExclusive`.
   */
  createEmptyFileExclusive(name: string): void {
    const filename = this.filePath(name);
    this.assertDirectoryUnchanged();
    this.removeInterruptedTemporaryFiles(name);
    if (pathExists(filename)) {
      throw new SecureLocalStateError(`${this.label} file already exists`);
    }

    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(
        filename,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          noFollowFlag(),
        FILE_MODE
      );
      fs.fchmodSync(descriptor, FILE_MODE);
      fs.fsyncSync(descriptor);
      const opened = fs.fstatSync(descriptor, { bigint: true });
      assertSecureFile(opened, this.expectedUid, this.label);
      if (opened.size !== 0n) {
        throw new SecureLocalStateError(`${this.label} empty file is not empty`);
      }
      fs.closeSync(descriptor);
      descriptor = undefined;
      this.fsyncDirectory();
      const published = secureFileStat(filename, this.expectedUid, this.label);
      if (!sameIdentity(opened, published) || published.size !== 0n) {
        throw new SecureLocalStateError(`${this.label} empty file identity changed`);
      }
      this.assertDirectoryUnchanged();
    } catch (error) {
      if (error instanceof SecureLocalStateError) throw error;
      if (isErrno(error, "EEXIST")) {
        throw new SecureLocalStateError(`${this.label} file already exists`, { cause: error });
      }
      throw new SecureLocalStateError(`${this.label} empty file could not be created durably`, {
        cause: error,
      });
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  readFile(name: string, maxBytes: number): Buffer {
    const filename = this.filePath(name);
    requireMaximumBytes(maxBytes);
    this.assertDirectoryUnchanged();
    this.removeInterruptedTemporaryFiles(name);

    let descriptor: number | undefined;
    let bytes: Buffer | undefined;
    try {
      const before = secureFileStat(filename, this.expectedUid, this.label);
      if (before.size <= 0n || before.size > BigInt(maxBytes)) {
        throw new SecureLocalStateError(`${this.label} file size is invalid`);
      }
      descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollowFlag());
      const opened = fs.fstatSync(descriptor, { bigint: true });
      assertSecureFile(opened, this.expectedUid, this.label);
      if (!sameIdentity(before, opened)) {
        throw new SecureLocalStateError(`${this.label} file changed while opening`);
      }

      bytes = readBounded(descriptor, maxBytes);
      const after = fs.fstatSync(descriptor, { bigint: true });
      assertSecureFile(after, this.expectedUid, this.label);
      const pathAfter = secureFileStat(filename, this.expectedUid, this.label);
      if (
        !sameSnapshot(opened, after) ||
        !sameIdentity(after, pathAfter) ||
        after.size !== BigInt(bytes.byteLength)
      ) {
        throw new SecureLocalStateError(`${this.label} file changed while reading`);
      }
      this.assertDirectoryUnchanged();
      return bytes;
    } catch (error) {
      bytes?.fill(0);
      if (error instanceof SecureLocalStateError) throw error;
      if (isErrno(error, "ENOENT")) {
        throw new SecureLocalStateError(`${this.label} file is missing`, { cause: error });
      }
      if (isErrno(error, "ELOOP")) {
        throw new SecureLocalStateError(`${this.label} file must not be a symbolic link`, {
          cause: error,
        });
      }
      throw new SecureLocalStateError(`${this.label} file could not be read securely`, {
        cause: error,
      });
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  /** Publish a new file durably without ever replacing an existing pathname. */
  createFileExclusive(name: string, bytes: Uint8Array, maxBytes: number): void {
    const filename = this.filePath(name);
    const content = boundedContent(bytes, maxBytes);
    this.assertDirectoryUnchanged();
    this.removeInterruptedTemporaryFiles(name);
    if (pathExists(filename)) {
      throw new SecureLocalStateError(`${this.label} file already exists`);
    }

    const temporary = this.temporaryPath(name, "create");
    let temporaryExists = false;
    try {
      const descriptor = fs.openSync(
        temporary,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          noFollowFlag(),
        FILE_MODE
      );
      temporaryExists = true;
      let temporaryStat: fs.BigIntStats;
      try {
        fs.fchmodSync(descriptor, FILE_MODE);
        writeAll(descriptor, content);
        fs.fsyncSync(descriptor);
        temporaryStat = fs.fstatSync(descriptor, { bigint: true });
        assertSecureFile(temporaryStat, this.expectedUid, this.label);
        if (temporaryStat.size !== BigInt(content.byteLength)) {
          throw new SecureLocalStateError(`${this.label} file write was incomplete`);
        }
      } finally {
        fs.closeSync(descriptor);
      }

      this.assertDirectoryUnchanged();
      fs.linkSync(temporary, filename);
      fs.unlinkSync(temporary);
      temporaryExists = false;
      this.fsyncDirectory();

      const published = secureFileStat(filename, this.expectedUid, this.label);
      if (!sameIdentity(temporaryStat, published) || published.size !== BigInt(content.byteLength)) {
        throw new SecureLocalStateError(`${this.label} file publication identity changed`);
      }
      this.assertDirectoryUnchanged();
    } catch (error) {
      if (temporaryExists) this.removeTemporaryAfterFailure(temporary);
      if (error instanceof SecureLocalStateError) throw error;
      if (isErrno(error, "EEXIST")) {
        throw new SecureLocalStateError(`${this.label} file already exists`, { cause: error });
      }
      throw new SecureLocalStateError(`${this.label} file could not be created durably`, {
        cause: error,
      });
    } finally {
      content.fill(0);
    }
  }

  /** Replace an existing file atomically, preserving either the old or new bytes across a crash. */
  replaceFileAtomic(name: string, bytes: Uint8Array, maxBytes: number): void {
    const filename = this.filePath(name);
    const content = boundedContent(bytes, maxBytes);
    this.assertDirectoryUnchanged();
    this.removeInterruptedTemporaryFiles(name);
    const original = secureFileStat(filename, this.expectedUid, this.label);
    const temporary = this.temporaryPath(name, "replace");
    let temporaryExists = false;

    try {
      const descriptor = fs.openSync(
        temporary,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          noFollowFlag(),
        FILE_MODE
      );
      temporaryExists = true;
      let temporaryStat: fs.BigIntStats;
      try {
        fs.fchmodSync(descriptor, FILE_MODE);
        writeAll(descriptor, content);
        fs.fsyncSync(descriptor);
        temporaryStat = fs.fstatSync(descriptor, { bigint: true });
        assertSecureFile(temporaryStat, this.expectedUid, this.label);
        if (temporaryStat.size !== BigInt(content.byteLength)) {
          throw new SecureLocalStateError(`${this.label} replacement write was incomplete`);
        }
      } finally {
        fs.closeSync(descriptor);
      }

      this.assertDirectoryUnchanged();
      const current = secureFileStat(filename, this.expectedUid, this.label);
      if (!sameSnapshot(original, current)) {
        throw new SecureLocalStateError(`${this.label} file changed before replacement`);
      }
      fs.renameSync(temporary, filename);
      temporaryExists = false;

      const published = secureFileStat(filename, this.expectedUid, this.label);
      if (!sameIdentity(temporaryStat, published) || published.size !== BigInt(content.byteLength)) {
        throw new SecureLocalStateError(`${this.label} replacement identity changed`);
      }
      this.fsyncDirectory();
      this.assertDirectoryUnchanged();
    } catch (error) {
      if (temporaryExists) this.removeTemporaryAfterFailure(temporary);
      if (error instanceof SecureLocalStateError) throw error;
      if (isErrno(error, "ENOENT")) {
        throw new SecureLocalStateError(`${this.label} file is missing`, { cause: error });
      }
      throw new SecureLocalStateError(`${this.label} file could not be replaced atomically`, {
        cause: error,
      });
    } finally {
      content.fill(0);
    }
  }

  private filePath(name: string): string {
    const leaf = requireLeafName(name);
    const filename = path.join(this.directory, leaf);
    if (path.dirname(filename) !== this.directory) {
      throw new SecureLocalStateError(`${this.label} filename escaped its directory`);
    }
    return filename;
  }

  private temporaryPath(name: string, kind: "create" | "replace"): string {
    const leaf = requireLeafName(name);
    return path.join(
      this.directory,
      `.${leaf}.${kind}-${process.pid}-${randomBytes(16).toString("hex")}.tmp`
    );
  }

  private removeInterruptedTemporaryFiles(name: string): void {
    const leaf = requireLeafName(name);
    const prefix = `.${leaf}.`;
    let changed = false;
    for (const entry of fs.readdirSync(this.directory)) {
      if (!entry.startsWith(prefix) || !TEMPORARY_SUFFIX_PATTERN.test(entry)) continue;
      const filename = path.join(this.directory, entry);
      const stat = fs.lstatSync(filename, { bigint: true });
      assertSecureTemporaryFile(stat, this.expectedUid, this.label);
      fs.unlinkSync(filename);
      changed = true;
    }
    if (changed) this.fsyncDirectory();
  }

  private removeTemporaryAfterFailure(filename: string): void {
    try {
      const stat = fs.lstatSync(filename, { bigint: true });
      assertSecureTemporaryFile(stat, this.expectedUid, this.label);
      fs.unlinkSync(filename);
      this.fsyncDirectory();
    } catch (cleanupError) {
      if (!isErrno(cleanupError, "ENOENT")) {
        // Preserve the primary fail-closed error. The temporary pathname is
        // never accepted by public reads and is cleaned on the next operation.
      }
    }
  }

  private assertDirectoryUnchanged(): void {
    let descriptor: number | undefined;
    try {
      assertCanonicalRealpath(this.directory, this.label);
      const pathBefore = fs.lstatSync(this.directory, { bigint: true });
      assertSecureDirectory(pathBefore, this.expectedUid, this.label);
      descriptor = fs.openSync(
        this.directory,
        fs.constants.O_RDONLY | directoryFlag() | noFollowFlag()
      );
      const opened = fs.fstatSync(descriptor, { bigint: true });
      assertSecureDirectory(opened, this.expectedUid, this.label);
      const pathAfter = fs.lstatSync(this.directory, { bigint: true });
      assertSecureDirectory(pathAfter, this.expectedUid, this.label);
      assertCanonicalRealpath(this.directory, this.label);
      if (
        !sameIdentity(pathBefore, opened) ||
        !sameIdentity(opened, pathAfter) ||
        !sameIdentity(opened, this.identity)
      ) {
        throw new SecureLocalStateError(`${this.label} directory identity changed`);
      }
    } catch (error) {
      if (error instanceof SecureLocalStateError) throw error;
      if (isErrno(error, "ELOOP")) {
        throw new SecureLocalStateError(`${this.label} directory must not be a symbolic link`, {
          cause: error,
        });
      }
      throw new SecureLocalStateError(`${this.label} directory identity could not be verified`, {
        cause: error,
      });
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  private fsyncDirectory(): void {
    this.assertDirectoryUnchanged();
    const descriptor = fs.openSync(
      this.directory,
      fs.constants.O_RDONLY | directoryFlag() | noFollowFlag()
    );
    try {
      const stat = fs.fstatSync(descriptor, { bigint: true });
      assertSecureDirectory(stat, this.expectedUid, this.label);
      if (!sameIdentity(stat, this.identity)) {
        throw new SecureLocalStateError(`${this.label} directory identity changed`);
      }
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    this.assertDirectoryUnchanged();
  }
}

type FileIdentity = Readonly<{ dev: bigint; ino: bigint }>;

function identityOf(stat: fs.BigIntStats): FileIdentity {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function sameIdentity(
  left: Pick<fs.BigIntStats, "dev" | "ino"> | FileIdentity,
  right: Pick<fs.BigIntStats, "dev" | "ino"> | FileIdentity
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertSecureDirectory(stat: fs.BigIntStats, uid: bigint, label: string): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new SecureLocalStateError(`${label} directory must be a real directory`);
  }
  if ((Number(stat.mode) & 0o777) !== DIRECTORY_MODE) {
    throw new SecureLocalStateError(`${label} directory permissions must be 0700`);
  }
  if (stat.uid !== uid) {
    throw new SecureLocalStateError(`${label} directory must be owned by the current user`);
  }
}

function secureFileStat(filename: string, uid: bigint, label: string): fs.BigIntStats {
  const stat = fs.lstatSync(filename, { bigint: true });
  assertSecureFile(stat, uid, label);
  return stat;
}

function assertSecureFile(stat: fs.BigIntStats, uid: bigint, label: string): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SecureLocalStateError(`${label} path must be a regular file`);
  }
  if ((Number(stat.mode) & 0o777) !== FILE_MODE) {
    throw new SecureLocalStateError(`${label} file permissions must be 0600`);
  }
  if (stat.uid !== uid) {
    throw new SecureLocalStateError(`${label} file must be owned by the current user`);
  }
  if (stat.nlink !== 1n) {
    throw new SecureLocalStateError(`${label} file must have exactly one filesystem link`);
  }
}

function assertSecureTemporaryFile(stat: fs.BigIntStats, uid: bigint, label: string): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SecureLocalStateError(`${label} temporary path must be a regular file`);
  }
  if ((Number(stat.mode) & 0o777) !== FILE_MODE || stat.uid !== uid) {
    throw new SecureLocalStateError(`${label} temporary file ownership or mode is invalid`);
  }
  if (stat.nlink < 1n || stat.nlink > 2n) {
    throw new SecureLocalStateError(`${label} temporary file link count is invalid`);
  }
}

function readBounded(descriptor: number, maxBytes: number): Buffer {
  const scratch = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  try {
    while (offset < scratch.byteLength) {
      const count = fs.readSync(descriptor, scratch, offset, scratch.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset === 0 || offset > maxBytes) {
      throw new SecureLocalStateError("secure local state file size is invalid");
    }
    return Buffer.from(scratch.subarray(0, offset));
  } finally {
    scratch.fill(0);
  }
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = fs.writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new SecureLocalStateError("secure local state write made no progress");
    offset += written;
  }
}

function boundedContent(bytes: Uint8Array, maxBytes: number): Buffer {
  requireMaximumBytes(maxBytes);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new SecureLocalStateError("secure local state content size is invalid");
  }
  return Buffer.from(bytes);
}

function requireMaximumBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 16 * 1024 * 1024) {
    throw new SecureLocalStateError("secure local state maximum size is invalid");
  }
}

function requireLeafName(name: string): string {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    Buffer.byteLength(name, "utf8") > MAX_LEAF_NAME_BYTES ||
    name === "." ||
    name === ".." ||
    path.basename(name) !== name ||
    name.includes("\0")
  ) {
    throw new SecureLocalStateError("secure local state filename is invalid");
  }
  return name;
}

function safeLabel(label: string): string {
  if (typeof label !== "string" || !/^[A-Za-z0-9 _-]{1,64}$/.test(label)) {
    return "local state";
  }
  return label;
}

function currentUid(fallback: bigint): bigint {
  return typeof process.getuid === "function" ? BigInt(process.getuid()) : fallback;
}

function assertNoSymlinkComponents(resolved: string, label: string): void {
  const root = path.parse(resolved).root;
  const relative = path.relative(root, resolved);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new SecureLocalStateError(`${label} path must not contain symbolic links`);
    }
  }
}

function assertCanonicalRealpath(directory: string, label: string): void {
  const canonical = fs.realpathSync.native(directory);
  if (canonical !== directory) {
    throw new SecureLocalStateError(`${label} path must equal its canonical real path`);
  }
}

function fsyncDirectoryEntry(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | directoryFlag() | noFollowFlag());
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
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

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}

function directoryFlag(): number {
  return typeof fs.constants.O_DIRECTORY === "number" ? fs.constants.O_DIRECTORY : 0;
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
